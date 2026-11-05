//! HiveCast forecast-wagering contract.
//!
//! Implements spec #1 (ticket #2): an immutable per-Question competition with
//! a single Round, Commit/Reveal wagering, paid Forecast Snapshot access,
//! exact Brier + stake-weighted-Query-Fee settlement, sponsored storage,
//! owner claimable balances, and async withdrawal with a private callback.
//!
//! See `docs/contract-interface.md` for the wire-level JSON contracts,
//! commitment byte layout, and event schemas consumed by the runner and
//! dashboard.

mod commitment;
mod scoring;

use near_sdk::borsh;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::store::{IterableMap, Lazy, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

use commitment::{commitment_hash, hex_decode, hex_encode};
use scoring::{allocate, base_numerators, fee_numerators, score, BPS_MAX, S, U256};

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/// 1 NEAR in yoctoNEAR.
pub const YOCTO_PER_NEAR: u128 = 1_000_000_000_000_000_000_000_000; // 1e24

/// Per-Question cap on total Stake (W) and Query Fee pool (F):
/// 1,000,000 NEAR = 1e30 yoctoNEAR.
pub const MAX_TOTAL_STAKE: u128 = 1_000_000_000_000_000_000_000_000_000_000; // 1e30
pub const MAX_FEE_POOL: u128 = 1_000_000_000_000_000_000_000_000_000_000; // 1e30

/// Maximum accepted Commitment per Question.
pub const MAX_PARTICIPANTS: u32 = 64;

/// Default minimum Stake: 0.1 NEAR.
pub const DEFAULT_MIN_STAKE: u128 = 100_000_000_000_000_000_000_000; // 1e23

/// Default Query Fee (Forecast Access price): 0.01 NEAR.
pub const DEFAULT_ACCESS_PRICE: u128 = 10_000_000_000_000_000_000_000; // 1e22

/// Storage staking cost: 1e19 yoctoNEAR per byte.
pub const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000; // 1e19

/// Per storage key/value record overhead in bytes (nearcore constant).
pub const RECORD_OVERHEAD: u64 = 40;

/// Length bounds for unbounded user/operator string fields.
pub const MAX_TEXT_LEN: usize = 2048;
pub const MAX_DEFINITION_LEN: usize = 2048;
pub const MAX_SOURCE_LEN: usize = 512;
pub const MAX_SALT_LEN: usize = 128;
pub const MAX_SNAPSHOT_ID_LEN: usize = 128;

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Operator,
    Questions,
    NextQuestionId,
    Commitments,
    QuestionParticipants,
    Buyers,
    QuestionBuyers,
    Balances,
    PendingWithdrawals,
    AccountWithdrawals,
    AccountWithdrawalCount,
    NextNonce,
    TotalLiabilities,
}

// ---------------------------------------------------------------------------
// Stored types
// ---------------------------------------------------------------------------

#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq)]
#[borsh(crate = "near_sdk::borsh")]
pub enum WithdrawalStatus {
    Pending,
    Delivered,
    Restored,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Question {
    pub text: String,
    pub event_definition: String,
    pub source: String,
    pub resolver: AccountId,
    pub open_time: u64,
    pub close_time: u64,
    pub observation_start: u64,
    pub observation_end: u64,
    pub resolve_time: u64,
    pub resolve_deadline: u64,
    pub reveal_window: u64,
    pub access_price: u128,
    pub min_stake: u128,
    // Lifecycle state.
    pub outcome: Option<bool>,
    pub resolved_at: Option<u64>,
    pub reveal_deadline: Option<u64>,
    pub settled: bool,
    pub cancelled: bool,
    pub zero_reveal_refund: bool,
    // Snapshot.
    pub snapshot_ready: bool,
    pub snapshot_id: Option<String>,
    // Aggregates.
    pub total_stake: u128,
    pub fee_pool: u128,
    pub participant_count: u32,
    pub buyer_count: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Commitment {
    pub hash: [u8; 32],
    pub stake: u128,
    pub revealed: Option<u16>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
pub struct BuyerReceipt {
    pub price: u128,
    pub refunded: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct BalanceRecord {
    pub claimable: u128,
    pub pending: u128,
    pub received: u128,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
pub struct PendingWithdrawal {
    pub nonce: u64,
    pub account: AccountId,
    pub amount: u128,
    pub status: WithdrawalStatus,
}

// ---------------------------------------------------------------------------
// Public JSON types (decimal strings for all monetary / timestamp fields)
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
pub struct QuestionSpec {
    pub text: String,
    pub event_definition: String,
    pub source: String,
    pub resolver: AccountId,
    pub open_time: U64,
    pub close_time: U64,
    pub observation_start: U64,
    pub observation_end: U64,
    pub resolve_time: Option<U64>,
    pub resolve_deadline: U64,
    pub reveal_window: U64,
    pub access_price: U128,
    pub min_stake: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct QuestionView {
    pub question_id: u64,
    pub text: String,
    pub event_definition: String,
    pub source: String,
    pub resolver: AccountId,
    pub open_time: String,
    pub close_time: String,
    pub observation_start: String,
    pub observation_end: String,
    pub resolve_time: String,
    pub resolve_deadline: String,
    pub reveal_window: String,
    pub access_price: String,
    pub min_stake: String,
    pub phase: String,
    pub outcome: Option<bool>,
    pub resolved_at: Option<String>,
    pub reveal_deadline: Option<String>,
    pub snapshot_ready: bool,
    pub snapshot_id: Option<String>,
    pub total_stake: String,
    pub fee_pool: String,
    pub participant_count: u32,
    pub buyer_count: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CommitmentView {
    pub question_id: u64,
    pub account_id: AccountId,
    pub stake: String,
    pub hash: String,
    pub revealed: Option<u16>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BuyerReceiptView {
    pub question_id: u64,
    pub account_id: AccountId,
    pub price: String,
    pub refunded: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BalanceView {
    pub account_id: AccountId,
    pub claimable: String,
    pub pending: String,
    pub received: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PendingWithdrawalView {
    pub nonce: u64,
    pub account_id: AccountId,
    pub amount: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ContractStateView {
    pub operator: AccountId,
    pub next_question_id: u64,
    pub next_nonce: u64,
    pub question_count: u64,
}

// ---------------------------------------------------------------------------
// Events (NEP-297 JSON)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct QuestionCreatedEvent {
    question_id: u64,
    resolver: AccountId,
    access_price: String,
    min_stake: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct CommitmentMadeEvent {
    question_id: u64,
    account_id: AccountId,
    stake: String,
    hash: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct SnapshotPublishedEvent {
    question_id: u64,
    snapshot_id: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct ForecastBoughtEvent {
    question_id: u64,
    account_id: AccountId,
    price: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct OutcomeResolvedEvent {
    question_id: u64,
    outcome: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct ForecastRevealedEvent {
    question_id: u64,
    account_id: AccountId,
    prob_bps: u16,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct SettledEvent {
    question_id: u64,
    zero_reveal: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct CancelledEvent {
    question_id: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct RefundClaimedEvent {
    question_id: u64,
    account_id: AccountId,
    amount: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct WithdrawalRequestedEvent {
    nonce: u64,
    account_id: AccountId,
    amount: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct WithdrawalDeliveredEvent {
    nonce: u64,
    account_id: AccountId,
    amount: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
struct WithdrawalRestoredEvent {
    nonce: u64,
    account_id: AccountId,
    amount: String,
}

fn emit<T: Serialize>(event_name: &str, data: &T) {
    let payload = near_sdk::serde_json::to_string(data).expect("event serialization");
    log!(
        "EVENT_JSON:{{\"standard\":\"hivecast\",\"version\":\"1.0.0\",\"event\":\"{event_name}\",\"data\":[{payload}]}}"
    );
}

fn fmt_u128(v: u128) -> String {
    v.to_string()
}
fn fmt_u64(v: u64) -> String {
    v.to_string()
}

// ---------------------------------------------------------------------------
// Contract state
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HiveCast {
    operator: Lazy<AccountId>,
    questions: IterableMap<u64, Question>,
    next_question_id: Lazy<u64>,
    commitments: LookupMap<(u64, AccountId), Commitment>,
    question_participants: LookupMap<u64, Vec<AccountId>>,
    buyers: LookupMap<(u64, AccountId), BuyerReceipt>,
    /// Per-question buyer index: `(question_id, index) -> account_id`. Enables
    /// O(limit) pagination reads without loading the whole buyer list.
    question_buyers: LookupMap<(u64, u64), AccountId>,
    balances: LookupMap<AccountId, BalanceRecord>,
    pending_withdrawals: LookupMap<u64, PendingWithdrawal>,
    /// Per-account withdrawal index: `(account_id, index) -> nonce`.
    account_withdrawals: LookupMap<(AccountId, u64), u64>,
    /// Number of withdrawal records per account (the next append index).
    account_withdrawal_count: LookupMap<AccountId, u32>,
    next_nonce: Lazy<u64>,
    /// Sum of all yoctoNEAR currently owed to users (active escrow stake/fee,
    /// claimable entitlements, and pending transfers not yet delivered).
    /// Decreases only when a withdrawal transfer is actually delivered; this is
    /// the authoritative floor the storage-sponsorship check must preserve.
    total_liabilities: Lazy<u128>,
}

#[near]
impl HiveCast {
    #[init]
    pub fn new(operator: AccountId) -> Self {
        Self {
            operator: Lazy::new(StorageKey::Operator, operator),
            questions: IterableMap::new(StorageKey::Questions),
            next_question_id: Lazy::new(StorageKey::NextQuestionId, 0u64),
            commitments: LookupMap::new(StorageKey::Commitments),
            question_participants: LookupMap::new(StorageKey::QuestionParticipants),
            buyers: LookupMap::new(StorageKey::Buyers),
            question_buyers: LookupMap::new(StorageKey::QuestionBuyers),
            balances: LookupMap::new(StorageKey::Balances),
            pending_withdrawals: LookupMap::new(StorageKey::PendingWithdrawals),
            account_withdrawals: LookupMap::new(StorageKey::AccountWithdrawals),
            account_withdrawal_count: LookupMap::new(StorageKey::AccountWithdrawalCount),
            next_nonce: Lazy::new(StorageKey::NextNonce, 0u64),
            total_liabilities: Lazy::new(StorageKey::TotalLiabilities, 0u128),
        }
    }

    // ------------------------------------------------------------------------
    // Authorization helpers
    // ------------------------------------------------------------------------

    fn assert_operator(&self) {
        require!(
            env::predecessor_account_id() == *self.operator.get(),
            "Only the operator may call this method"
        );
    }

    // ------------------------------------------------------------------------
    // Question creation
    // ------------------------------------------------------------------------

    #[payable]
    pub fn create_question(&mut self, spec: QuestionSpec) -> u64 {
        self.assert_operator();

        let open_time = spec.open_time.0;
        let close_time = spec.close_time.0;
        let observation_start = spec.observation_start.0;
        let observation_end = spec.observation_end.0;
        let resolve_time = spec.resolve_time.map(|v| v.0).unwrap_or(observation_end);
        let resolve_deadline = spec.resolve_deadline.0;
        let reveal_window = spec.reveal_window.0;
        let access_price = spec.access_price.0;
        let min_stake = spec.min_stake.0;

        require!(
            open_time < close_time
                && close_time < observation_start
                && observation_start < observation_end
                && observation_end <= resolve_time
                && resolve_time < resolve_deadline,
            "Invalid schedule ordering"
        );
        require!(reveal_window > 0, "Reveal window must be positive");
        require!(min_stake > 0, "Minimum stake must be positive");
        require!(min_stake <= MAX_TOTAL_STAKE, "Minimum stake exceeds cap");
        require!(access_price <= MAX_FEE_POOL, "Access price exceeds cap");
        require!(!spec.text.is_empty() && spec.text.len() <= MAX_TEXT_LEN, "Invalid text length");
        require!(
            !spec.event_definition.is_empty() && spec.event_definition.len() <= MAX_DEFINITION_LEN,
            "Invalid event definition length"
        );
        require!(!spec.source.is_empty() && spec.source.len() <= MAX_SOURCE_LEN, "Invalid source length");

        let question_id = *self.next_question_id.get();
        self.next_question_id.set(question_id + 1);

        let q = Question {
            text: spec.text,
            event_definition: spec.event_definition,
            source: spec.source,
            resolver: spec.resolver.clone(),
            open_time,
            close_time,
            observation_start,
            observation_end,
            resolve_time,
            resolve_deadline,
            reveal_window,
            access_price,
            min_stake,
            outcome: None,
            resolved_at: None,
            reveal_deadline: None,
            settled: false,
            cancelled: false,
            zero_reveal_refund: false,
            snapshot_ready: false,
            snapshot_id: None,
            total_stake: 0,
            fee_pool: 0,
            participant_count: 0,
            buyer_count: 0,
        };

        // Precise storage admission (key + value + record overhead), with no
        // incoming liability (questions carry no user funds).
        let key_bytes = borsh::to_vec(&question_id).expect("question key ser").len() as u64;
        let value_bytes = borsh::to_vec(&q).expect("question value ser").len() as u64;
        let additional = key_bytes + value_bytes + 2 * RECORD_OVERHEAD;
        self.ensure_storage_growth(additional, 0, &format!("question {question_id}"));

        self.questions.insert(question_id, q);

        emit(
            "question_created",
            &QuestionCreatedEvent {
                question_id,
                resolver: spec.resolver,
                access_price: fmt_u128(access_price),
                min_stake: fmt_u128(min_stake),
            },
        );

        question_id
    }

    // ------------------------------------------------------------------------
    // Commitment
    // ------------------------------------------------------------------------

    #[payable]
    pub fn commit(&mut self, question_id: u64, hash: String) {
        let now = env::block_timestamp();
        // The owner of the stake is the predecessor account that actually
        // attached the deposit, not a signer behind a cross-contract relay.
        let account = env::predecessor_account_id();
        let stake = env::attached_deposit().as_yoctonear();

        let mut q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(!q.cancelled && !q.settled && q.outcome.is_none(), "Round is not accepting commitments");
        require!(q.open_time <= now && now < q.close_time, "Commitment window is closed");
        require!(stake >= q.min_stake, "Stake below minimum");
        require!(
            q.total_stake.checked_add(stake).map_or(false, |v| v <= MAX_TOTAL_STAKE),
            "Stake exceeds per-question cap"
        );
        require!(q.participant_count < MAX_PARTICIPANTS, "Participant cap reached");
        require!(
            !self.commitments.contains_key(&(question_id, account.clone())),
            "Account already committed"
        );

        let hash_bytes: [u8; 32] = hex_decode(&hash)
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| env::panic_str("Invalid commitment hash"));

        let commitment = Commitment {
            hash: hash_bytes,
            stake,
            revealed: None,
        };

        // Precise storage admission: commitment record + the growth of the
        // per-question participant index. The incoming stake is a NEW
        // liability that must not subsidize its own storage.
        let key_bytes = borsh::to_vec(&(question_id, account.clone()))
            .expect("commitment key ser")
            .len() as u64;
        let value_bytes = borsh::to_vec(&commitment).expect("commitment value ser").len() as u64;
        let mut additional = key_bytes + value_bytes + 2 * RECORD_OVERHEAD;

        let old_participants = self
            .question_participants
            .get(&question_id)
            .cloned()
            .unwrap_or_default();
        let old_idx_bytes = borsh::to_vec(&old_participants).expect("idx ser").len() as u64;
        let mut new_participants = old_participants;
        new_participants.push(account.clone());
        let new_idx_bytes = borsh::to_vec(&new_participants).expect("idx ser").len() as u64;
        additional += new_idx_bytes.saturating_sub(old_idx_bytes);

        self.ensure_storage_growth(additional, stake, &format!("commitment {question_id} {account}"));

        self.commitments
            .insert((question_id, account.clone()), commitment);
        self.question_participants.insert(question_id, new_participants);

        self.add_liability(stake);

        q.total_stake += stake;
        q.participant_count += 1;
        self.questions.insert(question_id, q);

        emit(
            "commitment_made",
            &CommitmentMadeEvent {
                question_id,
                account_id: account,
                stake: fmt_u128(stake),
                hash,
            },
        );
    }

    // ------------------------------------------------------------------------
    // Snapshot readiness (operator)
    // ------------------------------------------------------------------------

    pub fn publish_snapshot(&mut self, question_id: u64, snapshot_id: String) {
        self.assert_operator();
        let now = env::block_timestamp();

        let mut q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(!q.cancelled && !q.settled && q.outcome.is_none(), "Round is not open for snapshot");
        require!(now >= q.close_time, "Snapshot only after commitment cutoff");
        require!(now < q.observation_start, "Snapshot sale window closed");
        require!(q.participant_count > 0, "Cannot snapshot an empty round");
        require!(
            snapshot_id.len() <= MAX_SNAPSHOT_ID_LEN && !snapshot_id.is_empty(),
            "Invalid snapshot identity"
        );

        q.snapshot_ready = true;
        q.snapshot_id = Some(snapshot_id.clone());
        self.questions.insert(question_id, q);

        emit(
            "snapshot_published",
            &SnapshotPublishedEvent {
                question_id,
                snapshot_id,
            },
        );
    }

    // ------------------------------------------------------------------------
    // Forecast purchase
    // ------------------------------------------------------------------------

    #[payable]
    pub fn buy_forecast(&mut self, question_id: u64) {
        let now = env::block_timestamp();
        // Buyer identity is the predecessor actually attaching the payment.
        let account = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();

        let mut q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(!q.cancelled && !q.settled && q.outcome.is_none(), "Round is not open for purchase");
        require!(q.snapshot_ready, "Snapshot not ready");
        require!(now >= q.close_time && now < q.observation_start, "Sale window is closed");
        require!(q.participant_count > 0, "No forecast to buy");
        require!(
            attached == q.access_price,
            "Payment must exactly match the access price"
        );
        require!(
            !self.buyers.contains_key(&(question_id, account.clone())),
            "Account already bought this forecast"
        );
        require!(
            q.fee_pool.checked_add(attached).map_or(false, |v| v <= MAX_FEE_POOL),
            "Fee pool exceeds cap"
        );

        let receipt = BuyerReceipt {
            price: attached,
            refunded: false,
        };

        // O(1) append: the next buyer index is the current count. Two records:
        // the buyer receipt and the per-question index entry. The attached fee
        // is a NEW liability that must not subsidize its storage.
        let buyer_index = q.buyer_count as u64;
        let key_bytes = borsh::to_vec(&(question_id, account.clone()))
            .expect("buyer key ser")
            .len() as u64;
        let value_bytes = borsh::to_vec(&receipt).expect("buyer value ser").len() as u64;
        let idx_key_bytes = borsh::to_vec(&(question_id, buyer_index))
            .expect("buyer idx key ser")
            .len() as u64;
        let idx_val_bytes = borsh::to_vec(&account).expect("buyer idx val ser").len() as u64;
        let additional = key_bytes
            + value_bytes
            + idx_key_bytes
            + idx_val_bytes
            + 4 * RECORD_OVERHEAD;

        self.ensure_storage_growth(additional, attached, &format!("buyer {question_id} {account}"));

        self.buyers.insert((question_id, account.clone()), receipt);
        self.question_buyers
            .insert((question_id, buyer_index), account.clone());

        self.add_liability(attached);

        q.fee_pool += attached;
        q.buyer_count += 1;
        self.questions.insert(question_id, q);

        emit(
            "forecast_bought",
            &ForecastBoughtEvent {
                question_id,
                account_id: account,
                price: fmt_u128(attached),
            },
        );
    }

    // ------------------------------------------------------------------------
    // Resolution (resolver-only)
    // ------------------------------------------------------------------------

    pub fn resolve(&mut self, question_id: u64, outcome: bool) {
        let now = env::block_timestamp();

        let mut q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(
            env::predecessor_account_id() == q.resolver,
            "Only the resolver may resolve"
        );
        require!(!q.cancelled && !q.settled && q.outcome.is_none(), "Already resolved or terminal");
        require!(
            q.resolve_time <= now && now < q.resolve_deadline,
            "Resolution window is not open"
        );

        let reveal_deadline = now.checked_add(q.reveal_window).expect("reveal deadline overflow");
        q.outcome = Some(outcome);
        q.resolved_at = Some(now);
        q.reveal_deadline = Some(reveal_deadline);
        self.questions.insert(question_id, q);

        emit(
            "outcome_resolved",
            &OutcomeResolvedEvent {
                question_id,
                outcome,
            },
        );
    }

    // ------------------------------------------------------------------------
    // Reveal
    // ------------------------------------------------------------------------

    pub fn reveal(&mut self, question_id: u64, prob_bps: u16, salt: String) {
        let now = env::block_timestamp();
        let account = env::predecessor_account_id();

        let q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(q.outcome.is_some(), "Round not resolved");
        require!(!q.settled && !q.cancelled, "Round is terminal");
        let reveal_deadline = q.reveal_deadline.expect("reveal deadline set at resolve");
        require!(now < reveal_deadline, "Reveal deadline passed");
        require!(prob_bps <= BPS_MAX, "Probability out of range");
        require!(salt.len() <= MAX_SALT_LEN, "Salt too long");

        let mut c = self
            .commitments
            .get(&(question_id, account.clone()))
            .unwrap_or_else(|| env::panic_str("No commitment for this account"))
            .clone();
        require!(c.revealed.is_none(), "Already revealed");

        // Recompute the canonical commitment and require an exact match.
        let contract_id = env::current_account_id();
        let expected = commitment_hash(
            contract_id.as_str(),
            question_id,
            account.as_str(),
            c.stake,
            prob_bps as u32,
            salt.as_bytes(),
        );
        require!(expected == c.hash, "Reveal does not match commitment");

        c.revealed = Some(prob_bps);
        self.commitments
            .insert((question_id, account.clone()), c);

        emit(
            "forecast_revealed",
            &ForecastRevealedEvent {
                question_id,
                account_id: account,
                prob_bps,
            },
        );
    }

    // ------------------------------------------------------------------------
    // Settlement (permissionless)
    // ------------------------------------------------------------------------

    pub fn settle(&mut self, question_id: u64) {
        let now = env::block_timestamp();

        let mut q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(q.outcome.is_some(), "Not resolved yet");
        require!(!q.settled && !q.cancelled, "Already settled or cancelled");
        let reveal_deadline = q.reveal_deadline.expect("reveal deadline set at resolve");
        require!(now >= reveal_deadline, "Reveal window still open");

        let outcome = q.outcome.expect("outcome present");

        // Collect participants (bounded <= 64) with stake and reveal state.
        let participants = self
            .question_participants
            .get(&question_id)
            .cloned()
            .unwrap_or_default();
        require!(
            participants.len() as u32 == q.participant_count,
            "Participant index inconsistent"
        );

        let mut base_inputs: Vec<(String, u128, u128)> = Vec::with_capacity(participants.len());
        let mut valid_revealers: Vec<(String, u128)> = Vec::new();
        for acct in &participants {
            let c = self
                .commitments
                .get(&(question_id, acct.clone()))
                .unwrap_or_else(|| env::panic_str("Commitment missing"))
                .clone();
            let s = match c.revealed {
                Some(p) => {
                    valid_revealers.push((acct.to_string(), c.stake));
                    score(p, outcome)
                }
                None => 0u128,
            };
            base_inputs.push((acct.to_string(), c.stake, s));
        }

        // Base pool: exact wagering payout conserving W.
        let (w, _a, base_shares) = base_numerators(&base_inputs, MAX_TOTAL_STAKE);
        let base_allocs = allocate(&base_shares, U256::from(w * S), w);

        // Fee pool: pro-rata stake among valid revealers only.
        let fee_pool = q.fee_pool;
        let zero_reveal;
        let fee_allocs: Vec<(String, u128)>;
        if !valid_revealers.is_empty() {
            let (v, fee_shares) = fee_numerators(&valid_revealers, fee_pool);
            fee_allocs = allocate(&fee_shares, U256::from(v), fee_pool);
            zero_reveal = false;
        } else {
            fee_allocs = Vec::new();
            zero_reveal = true;
        }

        // Credit claimable balances exactly once.
        let base_map: std::collections::HashMap<String, u128> =
            base_allocs.into_iter().collect();
        let fee_map: std::collections::HashMap<String, u128> =
            fee_allocs.into_iter().collect();
        for acct in &participants {
            let key = acct.to_string();
            let base = base_map.get(&key).copied().unwrap_or(0);
            let fee = fee_map.get(&key).copied().unwrap_or(0);
            let total = base.checked_add(fee).expect("payout overflow");
            if total > 0 {
                self.credit_claimable(acct.clone(), total);
            }
        }

        q.settled = true;
        q.zero_reveal_refund = zero_reveal;
        self.questions.insert(question_id, q);

        emit(
            "settled",
            &SettledEvent {
                question_id,
                zero_reveal,
            },
        );
    }

    // ------------------------------------------------------------------------
    // Cancellation (permissionless)
    // ------------------------------------------------------------------------

    pub fn cancel(&mut self, question_id: u64) {
        let now = env::block_timestamp();

        let mut q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(!q.cancelled && !q.settled && q.outcome.is_none(), "Round already terminal");

        let zero_commitments = q.participant_count == 0;
        let timeout = now >= q.resolve_deadline;
        require!(
            (zero_commitments && now >= q.close_time) || timeout,
            "Cancellation not eligible"
        );

        // Refund all accepted stakes to their owners (only in the timeout
        // path; the zero-commitment path has no agents to refund).
        if !zero_commitments {
            let participants = self
                .question_participants
                .get(&question_id)
                .cloned()
                .unwrap_or_default();
            for acct in &participants {
                let c = self
                    .commitments
                    .get(&(question_id, acct.clone()))
                    .unwrap_or_else(|| env::panic_str("Commitment missing"))
                    .clone();
                self.credit_claimable(acct.clone(), c.stake);
            }
        }

        q.cancelled = true;
        self.questions.insert(question_id, q);

        emit("cancelled", &CancelledEvent { question_id });
    }

    // ------------------------------------------------------------------------
    // Buyer refund (exactly-once, per-owner)
    // ------------------------------------------------------------------------

    pub fn claim_buyer_refund(&mut self, question_id: u64) {
        let account = env::predecessor_account_id();

        let q = self
            .questions
            .get(&question_id)
            .unwrap_or_else(|| env::panic_str("Question not found"))
            .clone();

        require!(
            q.cancelled || q.zero_reveal_refund,
            "Refund not eligible"
        );

        let mut receipt = self
            .buyers
            .get(&(question_id, account.clone()))
            .unwrap_or_else(|| env::panic_str("No buyer receipt"))
            .clone();
        require!(!receipt.refunded, "Refund already claimed");

        let amount = receipt.price;
        receipt.refunded = true;
        self.buyers
            .insert((question_id, account.clone()), receipt);

        self.credit_claimable(account.clone(), amount);

        emit(
            "refund_claimed",
            &RefundClaimedEvent {
                question_id,
                account_id: account,
                amount: fmt_u128(amount),
            },
        );
    }

    // ------------------------------------------------------------------------
    // Withdrawal (async with private callback)
    // ------------------------------------------------------------------------

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let account = env::predecessor_account_id();
        let amount = amount.0;
        require!(amount > 0, "Amount must be positive");

        let mut bal = self
            .balances
            .get(&account)
            .cloned()
            .unwrap_or_default();
        require!(amount <= bal.claimable, "Insufficient claimable balance");

        let nonce = *self.next_nonce.get();
        self.next_nonce.set(nonce + 1);

        // Debit claimable into pending before issuing the transfer.
        bal.claimable -= amount;
        bal.pending += amount;
        self.balances.insert(account.clone(), bal);

        let wd = PendingWithdrawal {
            nonce,
            account: account.clone(),
            amount,
            status: WithdrawalStatus::Pending,
        };

        // O(1) append: the next withdrawal index is the current per-account
        // count. Two records plus the count bump. No new liability (funds are
        // already in custody as claimable).
        let wd_index = self
            .account_withdrawal_count
            .get(&account)
            .copied()
            .unwrap_or(0);
        let key_bytes = borsh::to_vec(&nonce).expect("wd key ser").len() as u64;
        let value_bytes = borsh::to_vec(&wd).expect("wd value ser").len() as u64;
        let idx_key_bytes = borsh::to_vec(&(account.clone(), wd_index as u64))
            .expect("wd idx key ser")
            .len() as u64;
        let idx_val_bytes = borsh::to_vec(&nonce).expect("wd idx val ser").len() as u64;
        let additional =
            key_bytes + value_bytes + idx_key_bytes + idx_val_bytes + 4 * RECORD_OVERHEAD;

        self.ensure_storage_growth(additional, 0, &format!("withdrawal {nonce}"));

        self.pending_withdrawals.insert(nonce, wd);
        self.account_withdrawals
            .insert((account.clone(), wd_index as u64), nonce);
        self.account_withdrawal_count
            .insert(account.clone(), wd_index + 1);

        emit(
            "withdrawal_requested",
            &WithdrawalRequestedEvent {
                nonce,
                account_id: account.clone(),
                amount: fmt_u128(amount),
            },
        );

        Promise::new(account)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_withdraw_callback(nonce),
            )
    }

    #[private]
    pub fn on_withdraw_callback(&mut self, nonce: u64) {
        let mut wd = self
            .pending_withdrawals
            .get(&nonce)
            .unwrap_or_else(|| env::panic_str("Unknown withdrawal nonce"))
            .clone();
        require!(
            wd.status == WithdrawalStatus::Pending,
            "Withdrawal already finalized"
        );

        let success = near_sdk::is_promise_success();
        let mut bal = self
            .balances
            .get(&wd.account)
            .cloned()
            .unwrap_or_default();

        if success {
            wd.status = WithdrawalStatus::Delivered;
            bal.pending -= wd.amount;
            bal.received += wd.amount;
            // Funds actually left the contract: release the liability.
            self.sub_liability(wd.amount);
            emit(
                "withdrawal_delivered",
                &WithdrawalDeliveredEvent {
                    nonce,
                    account_id: wd.account.clone(),
                    amount: fmt_u128(wd.amount),
                },
            );
        } else {
            wd.status = WithdrawalStatus::Restored;
            bal.pending -= wd.amount;
            bal.claimable += wd.amount;
            // Funds stay in custody: liability unchanged.
            emit(
                "withdrawal_restored",
                &WithdrawalRestoredEvent {
                    nonce,
                    account_id: wd.account.clone(),
                    amount: fmt_u128(wd.amount),
                },
            );
        }

        self.pending_withdrawals.insert(nonce, wd.clone());
        self.balances.insert(wd.account.clone(), bal);
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------

    pub fn get_contract_state(&self) -> ContractStateView {
        ContractStateView {
            operator: self.operator.get().clone(),
            next_question_id: *self.next_question_id.get(),
            next_nonce: *self.next_nonce.get(),
            question_count: self.questions.len() as u64,
        }
    }

    pub fn get_question(&self, question_id: u64) -> Option<QuestionView> {
        self.questions.get(&question_id).map(|q| self.question_view(question_id, q))
    }

    pub fn list_questions(&self, from_index: u64, limit: u64) -> Vec<QuestionView> {
        let limit = limit.clamp(1, 100);
        // Question IDs are sequential from 0; read O(limit) keys directly.
        let total = *self.next_question_id.get();
        let end = total.min(from_index.saturating_add(limit));
        (from_index..end)
            .filter_map(|k| self.questions.get(&k).map(|q| self.question_view(k, q)))
            .collect()
    }

    pub fn get_commitment(&self, question_id: u64, account_id: AccountId) -> Option<CommitmentView> {
        self.commitments
            .get(&(question_id, account_id.clone()))
            .map(|c| CommitmentView {
                question_id,
                account_id,
                stake: fmt_u128(c.stake),
                hash: hex_encode(&c.hash),
                revealed: c.revealed,
            })
    }

    pub fn list_commitments(
        &self,
        question_id: u64,
        from_index: u64,
        limit: u64,
    ) -> Vec<CommitmentView> {
        let limit = limit.clamp(1, 64);
        let participants = self
            .question_participants
            .get(&question_id)
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for acct in participants.into_iter().skip(from_index as usize).take(limit as usize) {
            if let Some(c) = self.commitments.get(&(question_id, acct.clone())) {
                out.push(CommitmentView {
                    question_id,
                    account_id: acct,
                    stake: fmt_u128(c.stake),
                    hash: hex_encode(&c.hash),
                    revealed: c.revealed,
                });
            }
        }
        out
    }

    pub fn has_bought(&self, question_id: u64, account_id: AccountId) -> bool {
        self.buyers.contains_key(&(question_id, account_id))
    }

    pub fn get_buyer_receipt(&self, question_id: u64, account_id: AccountId) -> Option<BuyerReceiptView> {
        self.buyers
            .get(&(question_id, account_id.clone()))
            .map(|r| BuyerReceiptView {
                question_id,
                account_id,
                price: fmt_u128(r.price),
                refunded: r.refunded,
            })
    }

    pub fn list_buyers(
        &self,
        question_id: u64,
        from_index: u64,
        limit: u64,
    ) -> Vec<BuyerReceiptView> {
        let limit = limit.clamp(1, 100);
        // Buyer count is bounded per question; read O(limit) index entries.
        let buyer_count = self
            .questions
            .get(&question_id)
            .map(|q| q.buyer_count as u64)
            .unwrap_or(0);
        let end = buyer_count.min(from_index.saturating_add(limit));
        let mut out = Vec::new();
        for idx in from_index..end {
            if let Some(acct) = self.question_buyers.get(&(question_id, idx)) {
                let account_id = acct.clone();
                if let Some(r) = self.buyers.get(&(question_id, account_id.clone())) {
                    out.push(BuyerReceiptView {
                        question_id,
                        account_id,
                        price: fmt_u128(r.price),
                        refunded: r.refunded,
                    });
                }
            }
        }
        out
    }

    pub fn get_balance(&self, account_id: AccountId) -> BalanceView {
        let bal = self.balances.get(&account_id).cloned().unwrap_or_default();
        BalanceView {
            account_id,
            claimable: fmt_u128(bal.claimable),
            pending: fmt_u128(bal.pending),
            received: fmt_u128(bal.received),
        }
    }

    pub fn get_pending_withdrawal(&self, nonce: u64) -> Option<PendingWithdrawalView> {
        self.pending_withdrawals.get(&nonce).map(|w| self.pending_view(w))
    }

    pub fn list_pending_withdrawals(
        &self,
        account_id: AccountId,
        from_index: u64,
        limit: u64,
    ) -> Vec<PendingWithdrawalView> {
        let limit = limit.clamp(1, 100);
        // Read O(limit) index entries via the per-account count.
        let count = self
            .account_withdrawal_count
            .get(&account_id)
            .copied()
            .unwrap_or(0) as u64;
        let end = count.min(from_index.saturating_add(limit));
        let mut out = Vec::new();
        for idx in from_index..end {
            if let Some(nonce) = self.account_withdrawals.get(&(account_id.clone(), idx)) {
                if let Some(w) = self.pending_withdrawals.get(nonce) {
                    out.push(self.pending_view(w));
                }
            }
        }
        out
    }

    // ------------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------------

    fn question_view(&self, question_id: u64, q: &Question) -> QuestionView {
        let now = env::block_timestamp();
        QuestionView {
            question_id,
            text: q.text.clone(),
            event_definition: q.event_definition.clone(),
            source: q.source.clone(),
            resolver: q.resolver.clone(),
            open_time: fmt_u64(q.open_time),
            close_time: fmt_u64(q.close_time),
            observation_start: fmt_u64(q.observation_start),
            observation_end: fmt_u64(q.observation_end),
            resolve_time: fmt_u64(q.resolve_time),
            resolve_deadline: fmt_u64(q.resolve_deadline),
            reveal_window: fmt_u64(q.reveal_window),
            access_price: fmt_u128(q.access_price),
            min_stake: fmt_u128(q.min_stake),
            phase: self.phase(q, now).to_string(),
            outcome: q.outcome,
            resolved_at: q.resolved_at.map(fmt_u64),
            reveal_deadline: q.reveal_deadline.map(fmt_u64),
            snapshot_ready: q.snapshot_ready,
            snapshot_id: q.snapshot_id.clone(),
            total_stake: fmt_u128(q.total_stake),
            fee_pool: fmt_u128(q.fee_pool),
            participant_count: q.participant_count,
            buyer_count: q.buyer_count,
        }
    }

    fn phase(&self, q: &Question, now: u64) -> Phase {
        if q.cancelled {
            return Phase::Cancelled;
        }
        if q.settled {
            return Phase::Settled;
        }
        if q.outcome.is_some() {
            return Phase::Resolved;
        }
        if now >= q.close_time {
            return Phase::Closed;
        }
        Phase::Open
    }

    fn pending_view(&self, w: &PendingWithdrawal) -> PendingWithdrawalView {
        PendingWithdrawalView {
            nonce: w.nonce,
            account_id: w.account.clone(),
            amount: fmt_u128(w.amount),
            status: match w.status {
                WithdrawalStatus::Pending => "pending".to_string(),
                WithdrawalStatus::Delivered => "delivered".to_string(),
                WithdrawalStatus::Restored => "restored".to_string(),
            },
        }
    }

    fn credit_claimable(&mut self, account: AccountId, amount: u128) {
        let mut bal = self.balances.get(&account).cloned().unwrap_or_default();
        bal.claimable = bal.claimable.checked_add(amount).expect("claimable overflow");
        self.balances.insert(account, bal);
    }

    fn add_liability(&mut self, amount: u128) {
        let v = self
            .total_liabilities
            .get()
            .checked_add(amount)
            .expect("liability overflow");
        self.total_liabilities.set(v);
    }

    fn sub_liability(&mut self, amount: u128) {
        let v = self
            .total_liabilities
            .get()
            .checked_sub(amount)
            .expect("liability underflow");
        self.total_liabilities.set(v);
    }

    /// Reject new state growth when the operator's storage sponsorship is
    /// insufficient.
    ///
    /// Available sponsorship is `account_balance - total_liabilities`: user
    /// funds (active escrow stake/fee, claimable entitlements, pending
    /// transfers) may never subsidize new state. `incoming_liability` is the
    /// yoctoNEAR this call is taking into custody (stake or fee) — it must be
    /// added to liabilities *before* the admission check so a deposit cannot
    /// be counted as free operator sponsorship. `additional_bytes` is the exact
    /// additional key+value bytes (with record overhead) the operation writes,
    /// computed from Borsh-serialized sizes at the call site.
    fn ensure_storage_growth(&self, additional_bytes: u64, incoming_liability: u128, label: &str) {
        let used = env::storage_usage();
        let projected = used
            .checked_add(additional_bytes)
            .expect("storage growth overflow");
        let required = (projected as u128)
            .checked_mul(STORAGE_BYTE_COST)
            .expect("storage cost overflow");
        // `account_balance()` already includes the attached deposit.
        let balance = env::account_balance().as_yoctonear();
        let liabilities = self
            .total_liabilities
            .get()
            .checked_add(incoming_liability)
            .expect("liability overflow");
        let sponsor = balance
            .checked_sub(liabilities)
            .expect("balance below liabilities");
        require!(
            sponsor >= required,
            format!("Insufficient storage sponsorship for {label}")
        );
    }
}

/// Lifecycle phase (view string).
#[derive(Clone, Copy, PartialEq)]
pub enum Phase {
    Open,
    Closed,
    Resolved,
    Settled,
    Cancelled,
}

impl Phase {
    pub fn to_string(&self) -> String {
        match self {
            Phase::Open => "open".to_string(),
            Phase::Closed => "closed".to_string(),
            Phase::Resolved => "resolved".to_string(),
            Phase::Settled => "settled".to_string(),
            Phase::Cancelled => "cancelled".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests (public-interface seam, run natively under `unit-testing`)
// ---------------------------------------------------------------------------

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use near_sdk::test_utils::{testing_env_with_promise_results, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, VMContext};

    const OP: &str = "operator.testnet";
    const RESOLVER: &str = "resolver.testnet";
    const CONTRACT: &str = "hivecast.testnet";

    fn ctx(signer: &str, predecessor: &str, deposit: u128, ts: u64) -> VMContext {
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .signer_account_id(signer.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            // Generous operator storage sponsorship (1000 NEAR).
            .account_balance(NearToken::from_yoctonear(
                1_000_000_000_000_000_000_000_000_000u128,
            ))
            .build()
    }

    fn init() -> HiveCast {
        testing_env!(ctx(OP, OP, 0, 0));
        HiveCast::new(OP.parse().unwrap())
    }

    fn ctx_bal(signer: &str, predecessor: &str, deposit: u128, balance: u128, ts: u64) -> VMContext {
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .signer_account_id(signer.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            .account_balance(NearToken::from_yoctonear(balance))
            .build()
    }

    fn spec() -> QuestionSpec {
        QuestionSpec {
            text: "Will it rain?".to_string(),
            event_definition: "precipitation_sum >= 1.0 mm".to_string(),
            source: "open-meteo ECMWF IFS 9km".to_string(),
            resolver: RESOLVER.parse().unwrap(),
            open_time: U64(1_000),
            close_time: U64(2_000),
            observation_start: U64(3_000),
            observation_end: U64(4_000),
            resolve_time: Some(U64(4_000)),
            resolve_deadline: U64(6_000),
            reveal_window: U64(1_000),
            access_price: U128(5),
            min_stake: U128(1),
        }
    }

    fn commit_hex(qid: u64, account: &str, stake: u128, prob: u16, salt: &str) -> String {
        hex_encode(&commitment_hash(
            CONTRACT,
            qid,
            account,
            stake,
            prob as u32,
            salt.as_bytes(),
        ))
    }

    /// Run a full two-agent lifecycle with fee, returning the contract and
    /// question id. Timestamps: commit@1500, snapshot/buy@2500, resolve@5000,
    /// reveal@5500, settle@6000.
    fn settled_two_agent() -> (HiveCast, u64) {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        // Alice: stake 60, forecast 100% YES. Bob: stake 40, forecast 0%.
        testing_env!(ctx("alice.testnet", "alice.testnet", 60, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 60, 10_000, "salt-a"));

        testing_env!(ctx("bob.testnet", "bob.testnet", 40, 1_500));
        c.commit(qid, commit_hex(qid, "bob.testnet", 40, 0, "salt-b"));

        // Publish snapshot.
        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap-1".to_string());

        // Charlie buys (access price = 5).
        testing_env!(ctx("charlie.testnet", "charlie.testnet", 5, 2_500));
        c.buy_forecast(qid);

        // Resolve YES.
        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);

        // Both reveal.
        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 5_500));
        c.reveal(qid, 10_000, "salt-a".to_string());
        testing_env!(ctx("bob.testnet", "bob.testnet", 0, 5_500));
        c.reveal(qid, 0, "salt-b".to_string());

        // Settle at reveal deadline.
        testing_env!(ctx("anyone", "anyone", 0, 6_000));
        c.settle(qid);

        (c, qid)
    }

    #[test]
    fn full_lifecycle_and_exact_conservation() {
        let (c, qid) = settled_two_agent();

        testing_env!(ctx("anyone", "anyone", 0, 6_000));
        let q = c.get_question(qid).unwrap();
        assert_eq!(q.phase, "settled");
        assert_eq!(q.outcome, Some(true));
        assert_eq!(q.total_stake, "100");
        assert_eq!(q.fee_pool, "5");

        // Alice: base 84 + fee 3 = 87. Bob: base 16 + fee 2 = 18.
        // (W=100, S=1e8; alice s=S, bob s=0 -> A=60e8.
        //  base_a = 60*(100S+100S-60S)/(100S)=60*1.4=84,
        //  base_b = 40*(100S+0-60S)/(100S)=40*0.4=16.
        //  fee: 5*60/100=3, 5*40/100=2.)
        assert_eq!(c.get_balance("alice.testnet".parse().unwrap()).claimable, "87");
        assert_eq!(c.get_balance("bob.testnet".parse().unwrap()).claimable, "18");

        // Total claimable (87+18) = 105 = W + F (100 + 5). Conservation.
        let alice: u128 = c.get_balance("alice.testnet".parse().unwrap()).claimable.parse().unwrap();
        let bob: u128 = c.get_balance("bob.testnet".parse().unwrap()).claimable.parse().unwrap();
        assert_eq!(alice + bob, 105);
    }

    #[test]
    fn question_created_with_correct_fields() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("anyone", "anyone", 0, 1_500));
        let q = c.get_question(qid).unwrap();
        assert_eq!(q.question_id, qid);
        assert_eq!(q.resolver, RESOLVER.parse::<AccountId>().unwrap());
        assert_eq!(q.access_price, "5");
        assert_eq!(q.min_stake, "1");
        assert_eq!(q.phase, "open");
    }

    #[test]
    #[should_panic(expected = "Invalid schedule ordering")]
    fn rejects_bad_schedule_ordering() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let mut s = spec();
        s.close_time = U64(5_000); // close after observation start
        c.create_question(s);
    }

    #[test]
    #[should_panic(expected = "Only the operator may call this method")]
    fn rejects_non_operator_create() {
        let mut c = init();
        testing_env!(ctx("mallory.testnet", "mallory.testnet", 0, 0));
        c.create_question(spec());
    }

    #[test]
    #[should_panic(expected = "Only the resolver may resolve")]
    fn rejects_non_resolver_resolution() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("mallory.testnet", "mallory.testnet", 0, 5_000));
        c.resolve(qid, true);
    }

    #[test]
    #[should_panic(expected = "Account already committed")]
    fn rejects_duplicate_commitment() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s1"));
        c.commit(qid, commit_hex(qid, "alice.testnet", 20, 5_000, "s2"));
    }

    #[test]
    #[should_panic(expected = "Stake below minimum")]
    fn rejects_below_minimum_stake() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        // min_stake = 1, deposit 0.
        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 0, 5_000, "s"));
    }

    #[test]
    #[should_panic(expected = "Commitment window is closed")]
    fn rejects_commitment_outside_window() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        // close_time = 2000; committing at 2000 is rejected (half-open).
        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 2_000));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));
    }

    #[test]
    #[should_panic(expected = "Reveal does not match commitment")]
    fn rejects_wrong_salt_reveal() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "real-salt"));

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);

        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 5_500));
        c.reveal(qid, 5_000, "wrong-salt".to_string());
    }

    #[test]
    #[should_panic(expected = "Reveal does not match commitment")]
    fn rejects_wrong_probability_reveal() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);

        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 5_500));
        c.reveal(qid, 4_999, "s".to_string());
    }

    #[test]
    #[should_panic(expected = "Reveal does not match commitment")]
    fn rejects_cross_account_commitment_copy() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);

        // Bob attempts to reveal with Alice's exact hash context -> mismatch.
        testing_env!(ctx("bob.testnet", "bob.testnet", 0, 5_500));
        c.reveal(qid, 5_000, "s".to_string());
    }

    #[test]
    #[should_panic(expected = "Already revealed")]
    fn rejects_duplicate_reveal() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);

        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 5_500));
        c.reveal(qid, 5_000, "s".to_string());
        c.reveal(qid, 5_000, "s".to_string());
    }

    #[test]
    #[should_panic(expected = "Reveal deadline passed")]
    fn rejects_late_reveal() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true); // reveal_deadline = 6000

        // At reveal_deadline (6000) reveal is rejected (half-open).
        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
        c.reveal(qid, 5_000, "s".to_string());
    }

    #[test]
    #[should_panic(expected = "Payment must exactly match the access price")]
    fn rejects_incorrect_payment() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));

        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap".to_string());

        // access price = 5, but pay 4.
        testing_env!(ctx("charlie.testnet", "charlie.testnet", 4, 2_500));
        c.buy_forecast(qid);
    }

    #[test]
    #[should_panic(expected = "Snapshot not ready")]
    fn rejects_purchase_before_snapshot() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));

        // No publish_snapshot yet.
        testing_env!(ctx("charlie.testnet", "charlie.testnet", 5, 2_500));
        c.buy_forecast(qid);
    }

    #[test]
    #[should_panic(expected = "Account already bought this forecast")]
    fn rejects_duplicate_purchase() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "s"));

        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap".to_string());

        testing_env!(ctx("charlie.testnet", "charlie.testnet", 5, 2_500));
        c.buy_forecast(qid);
        c.buy_forecast(qid);
    }

    #[test]
    fn zero_reveal_refunds_fee_and_stakes() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 60, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 60, 5_000, "a"));
        testing_env!(ctx("bob.testnet", "bob.testnet", 40, 1_500));
        c.commit(qid, commit_hex(qid, "bob.testnet", 40, 5_000, "b"));

        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap".to_string());

        testing_env!(ctx("charlie.testnet", "charlie.testnet", 5, 2_500));
        c.buy_forecast(qid);

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);

        // Nobody reveals -> zero valid revealers.
        testing_env!(ctx("anyone", "anyone", 0, 6_000));
        c.settle(qid);

        // Base payout returns each stake (zero score for all).
        assert_eq!(c.get_balance("alice.testnet".parse().unwrap()).claimable, "60");
        assert_eq!(c.get_balance("bob.testnet".parse().unwrap()).claimable, "40");

        // Buyer can claim refund exactly once.
        testing_env!(ctx("charlie.testnet", "charlie.testnet", 0, 6_000));
        c.claim_buyer_refund(qid);
        assert_eq!(c.get_balance("charlie.testnet".parse().unwrap()).claimable, "5");

        // Receipt flag flips to refunded.
        let receipt = c
            .get_buyer_receipt(qid, "charlie.testnet".parse().unwrap())
            .unwrap();
        assert!(receipt.refunded);
    }

    #[test]
    #[should_panic(expected = "Refund already claimed")]
    fn rejects_duplicate_buyer_refund() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "a"));

        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap".to_string());

        testing_env!(ctx("charlie.testnet", "charlie.testnet", 5, 2_500));
        c.buy_forecast(qid);

        // No resolution -> timeout cancellation makes the fee refundable.
        testing_env!(ctx("anyone", "anyone", 0, 6_000));
        c.cancel(qid);

        testing_env!(ctx("charlie.testnet", "charlie.testnet", 0, 6_000));
        c.claim_buyer_refund(qid);
        c.claim_buyer_refund(qid);
    }

    #[test]
    fn timeout_cancellation_refunds_stake_and_fee() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("alice.testnet", "alice.testnet", 60, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 60, 5_000, "a"));

        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap".to_string());

        testing_env!(ctx("charlie.testnet", "charlie.testnet", 5, 2_500));
        c.buy_forecast(qid);

        // No resolution by resolve_deadline (6000) -> timeout cancellation.
        testing_env!(ctx("anyone", "anyone", 0, 6_000));
        c.cancel(qid);

        let q = c.get_question(qid).unwrap();
        assert_eq!(q.phase, "cancelled");

        // Agent stake refunded.
        assert_eq!(c.get_balance("alice.testnet".parse().unwrap()).claimable, "60");

        // Buyer refunds via per-receipt claim.
        testing_env!(ctx("charlie.testnet", "charlie.testnet", 0, 6_000));
        c.claim_buyer_refund(qid);
        assert_eq!(c.get_balance("charlie.testnet".parse().unwrap()).claimable, "5");
    }

    #[test]
    fn zero_commitment_cancels_after_cutoff() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        // No commitments; cancel at close_time.
        testing_env!(ctx("anyone", "anyone", 0, 2_000));
        c.cancel(qid);

        let q = c.get_question(qid).unwrap();
        assert_eq!(q.phase, "cancelled");
    }

    #[test]
    #[should_panic(expected = "Round already terminal")]
    fn cancelled_round_cannot_resolve() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        testing_env!(ctx("anyone", "anyone", 0, 2_000));
        c.cancel(qid);

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);
    }

    #[test]
    fn withdraw_pending_then_delivered_via_callback() {
        let (mut c, qid) = settled_two_agent();
        let _ = qid;

        // Alice has 87 claimable.
        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
        assert_eq!(c.get_balance("alice.testnet".parse().unwrap()).claimable, "87");

        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
        c.withdraw(U128(87));

        // Pending: claimable 0, pending 87.
        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
        let bal = c.get_balance("alice.testnet".parse().unwrap());
        assert_eq!(bal.claimable, "0");
        assert_eq!(bal.pending, "87");

        // Callback: transfer succeeded.
        testing_env_with_promise_results(
            ctx("hivecast.testnet", "hivecast.testnet", 0, 6_000),
            PromiseResult::Successful(vec![]),
        );
        c.on_withdraw_callback(0);

        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
        let bal = c.get_balance("alice.testnet".parse().unwrap());
        assert_eq!(bal.pending, "0");
        assert_eq!(bal.received, "87");
    }

    #[test]
    fn withdraw_failure_restores_claimable() {
        let (mut c, qid) = settled_two_agent();
        let _ = qid;

        testing_env!(ctx("bob.testnet", "bob.testnet", 0, 6_000));
        c.withdraw(U128(18));

        // Callback: transfer failed -> restore.
        testing_env_with_promise_results(
            ctx("hivecast.testnet", "hivecast.testnet", 0, 6_000),
            PromiseResult::Failed,
        );
        c.on_withdraw_callback(0);

        testing_env!(ctx("bob.testnet", "bob.testnet", 0, 6_000));
        let bal = c.get_balance("bob.testnet".parse().unwrap());
        assert_eq!(bal.pending, "0");
        assert_eq!(bal.claimable, "18");
        assert_eq!(bal.received, "0");
    }

    #[test]
    #[should_panic(expected = "Insufficient claimable balance")]
    fn rejects_over_withdraw() {
        let (mut c, qid) = settled_two_agent();
        let _ = qid;

        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
        c.withdraw(U128(88)); // only 87 available
    }

    #[test]
    fn sixty_four_participants_settle_with_conservation() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        // 64 participants, each stake 1, forecast 50%.
        for i in 0..64u32 {
            let acct = format!("p{i}.testnet");
            testing_env!(ctx(&acct, &acct, 1, 1_500));
            c.commit(qid, commit_hex(qid, &acct, 1, 5_000, "s"));
        }

        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap".to_string());

        // One buyer: access price 5 -> fee pool 5 (does not divide evenly).
        testing_env!(ctx("buyer.testnet", "buyer.testnet", 5, 2_500));
        c.buy_forecast(qid);

        testing_env!(ctx(RESOLVER, RESOLVER, 0, 5_000));
        c.resolve(qid, true);

        // All reveal 50% (valid).
        for i in 0..64u32 {
            let acct = format!("p{i}.testnet");
            testing_env!(ctx(&acct, &acct, 0, 5_500));
            c.reveal(qid, 5_000, "s".to_string());
        }

        testing_env!(ctx("anyone", "anyone", 0, 6_000));
        c.settle(qid);

        // Every participant has equal score: base payout = stake = 1 each.
        // Fee: 5 over 64 revealers, stake-equal -> 5 yocto distributed to 5
        // largest-remainder accounts (all remainders 0.078125, tie-broken by
        // account ascending -> p0..p4 get 1 extra).
        let mut total_claimable: u128 = 0;
        for i in 0..64u32 {
            let acct = format!("p{i}.testnet");
            let v: u128 = c
                .get_balance(acct.parse().unwrap())
                .claimable
                .parse()
                .unwrap();
            total_claimable += v;
        }
        // W = 64, F = 5 -> total 69.
        assert_eq!(total_claimable, 69);
    }

    #[test]
    #[should_panic(expected = "Participant cap reached")]
    fn rejects_sixty_fifth_participant() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        for i in 0..64u32 {
            let acct = format!("p{i}.testnet");
            testing_env!(ctx(&acct, &acct, 1, 1_500));
            c.commit(qid, commit_hex(qid, &acct, 1, 5_000, "s"));
        }

        let acct = "p64.testnet";
        testing_env!(ctx(acct, acct, 1, 1_500));
        c.commit(qid, commit_hex(qid, acct, 1, 5_000, "s"));
    }

    #[test]
    #[should_panic(expected = "Insufficient storage sponsorship")]
    fn prior_liability_blocks_new_commit_without_reserve() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        // Alice takes 100 yocto of stake into custody (a user liability).
        testing_env!(ctx("alice.testnet", "alice.testnet", 100, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 100, 5_000, "a"));

        // Operator's balance is now exactly the 100 yocto owed to Alice plus
        // 1 yocto — no free sponsor reserve beyond the existing liability.
        // Bob's new commitment must be rejected rather than spending Alice's
        // funds on storage.
        testing_env!(ctx_bal("bob.testnet", "bob.testnet", 1, 101, 1_500));
        c.commit(qid, commit_hex(qid, "bob.testnet", 1, 5_000, "b"));
    }

    #[test]
    fn buyer_pagination_is_bounded_and_high_offset_works() {
        let mut c = init();
        testing_env!(ctx(OP, OP, 0, 0));
        let qid = c.create_question(spec());

        // One participant so snapshot is publishable and sale is open.
        testing_env!(ctx("alice.testnet", "alice.testnet", 10, 1_500));
        c.commit(qid, commit_hex(qid, "alice.testnet", 10, 5_000, "a"));

        testing_env!(ctx(OP, OP, 0, 2_500));
        c.publish_snapshot(qid, "snap".to_string());

        // 6 buyers, access_price = 5.
        for i in 0..6u32 {
            let acct = format!("b{i}.testnet");
            testing_env!(ctx(&acct, &acct, 5, 2_500));
            c.buy_forecast(qid);
        }

        // Page [2,4) via the public interface.
        testing_env!(ctx("anyone", "anyone", 0, 2_500));
        let page = c.list_buyers(qid, 2, 2);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].account_id.as_str(), "b2.testnet");
        assert_eq!(page[1].account_id.as_str(), "b3.testnet");

        // A high offset beyond the end returns an empty page (bounded read).
        let page = c.list_buyers(qid, 1000, 10);
        assert!(page.is_empty());
    }

    #[test]
    fn withdrawal_pagination_is_bounded() {
        let (mut c, qid) = settled_two_agent();
        let _ = qid;

        // Alice (87 claimable) issues three small withdrawals: nonces 0,1,2.
        for _ in 0..3 {
            testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
            c.withdraw(U128(10));
        }

        // Page the middle entry via the public interface.
        testing_env!(ctx("alice.testnet", "alice.testnet", 0, 6_000));
        let page = c
            .list_pending_withdrawals("alice.testnet".parse().unwrap(), 1, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].nonce, 1);

        // High offset returns empty (bounded read, no full-history load).
        let page = c
            .list_pending_withdrawals("alice.testnet".parse().unwrap(), 1000, 10);
        assert!(page.is_empty());
    }
}
