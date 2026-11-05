//! Real near-sandbox integration tests for the HiveCast contract.
//!
//! These tests deploy the already-built release WASM artifact to a local
//! `near-sandbox` node, then exercise the full public lifecycle through real
//! transactions — not the near-sdk mock VM and not a mocked chain success. They
//! also measure real settlement gas for a 64-participant Round.
//!
//! Time handling: sandbox block timestamps advance with each transaction, so
//! participant accounts are created *before* the commitment window, and all
//! phase transitions are driven by `fast_forward` to computed targets using
//! generous virtual deadlines (never real sleeps, never tight windows).
//!
//! Arg format: near-sdk 5.5.0 deserializes method arguments as a JSON object
//! keyed by parameter name (see the `args_return_mut.snap` expansion), so all
//! `args_json` calls here use named objects, exactly as the runner will.

use borsh::BorshSerialize;
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use sha2::{Digest, Sha256};

const NEAR_NS: u64 = 1_000_000_000; // 1 second in nanoseconds
const MAX_SETTLE_GAS: u64 = 300_000_000_000_000; // 300 TGas

// ---------------------------------------------------------------------------
// Commitment preimage — independent re-implementation of the byte layout
// documented in docs/contract-interface.md, so on-chain reveal matching is
// verified against an encoding the contract does NOT supply to this test.
// ---------------------------------------------------------------------------

#[derive(BorshSerialize)]
#[borsh(crate = "borsh")]
struct Preimage<'a> {
    domain: &'a str,
    version: u32,
    contract_id: &'a str,
    question_id: u64,
    account_id: &'a str,
    stake_yocto: u128,
    prob_bps: u32,
    salt: Vec<u8>,
}

fn commitment_hash(
    contract_id: &str,
    question_id: u64,
    account_id: &str,
    stake_yocto: u128,
    prob_bps: u16,
    salt: &str,
) -> String {
    let img = Preimage {
        domain: "hivecast",
        version: 1,
        contract_id,
        question_id,
        account_id,
        stake_yocto,
        prob_bps: prob_bps as u32,
        salt: salt.as_bytes().to_vec(),
    };
    let bytes = borsh::to_vec(&img).expect("preimage serialization");
    hex::encode(Sha256::digest(&bytes))
}

/// Advance the sandbox clock to at least `target_ns`.
///
/// The mapping between fast-forward block height and timestamp is not assumed
/// to be 1 block = 1 second. Instead we observe the actual per-block timestamp
/// delta, fast-forward the computed number of blocks, then step single blocks
/// until the *observed* block timestamp passes `target_ns` — landing just past
/// the target without grossly overshooting into a later phase.
async fn advance_to(worker: &Worker<Sandbox>, target_ns: u64) -> anyhow::Result<()> {
    let t0 = worker.view_block().await?.timestamp();
    if t0 >= target_ns {
        return Ok(());
    }

    // Observe the real per-block timestamp delta (>= 1 ns).
    worker.fast_forward(1).await?;
    let t1 = worker.view_block().await?.timestamp();
    let per_block = t1.saturating_sub(t0).max(1);

    // Fast-forward the bulk of the remaining distance.
    let remaining = target_ns.saturating_sub(t1);
    let bulk_blocks = remaining.div_ceil(per_block);
    if bulk_blocks > 0 {
        worker.fast_forward(bulk_blocks).await?;
    }

    // Fine-tune with single-block steps until the observed timestamp passes
    // the target.
    let mut guard = 0u32;
    while worker.view_block().await?.timestamp() < target_ns {
        worker.fast_forward(1).await?;
        guard += 1;
        anyhow::ensure!(guard < 10_000, "sandbox clock stuck before {target_ns}");
    }
    Ok(())
}

/// Deploy the contract, fund it for storage sponsorship, and create the
/// operator, resolver, and buyer subaccounts.
/// near-sandbox node version pinned to match the runtime that parses the
/// current-compiler WASM (nearcore 2.14.0-rc.5, protocol 88). The
/// near-workspaces 0.13 default (2.0.0, Aug 2024) predates the toolchain that
/// produces this WASM and fails init with PrepareError/Deserialization.
const SANDBOX_VERSION: &str = "2.14.0-rc.5";

async fn deploy() -> anyhow::Result<(Worker<Sandbox>, Contract, Account, Account, Account)> {
    let worker = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
    // Deploy the already-built release WASM artifact (built by the workflow's
    // earlier `cargo build --target wasm32-unknown-unknown --release` step)
    // rather than invoking `compile_project`, which re-runs cargo with the
    // near-sdk ABI-generation feature and triggers unrelated JsonSchema errors.
    let wasm_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/wasm32-unknown-unknown/release/hivecast.wasm"
    );
    let wasm = std::fs::read(wasm_path).unwrap_or_else(|e| {
        panic!(
            "deployable WASM missing at {wasm_path} ({e}); build it first with: \
             RUSTFLAGS='-C link-arg=-s' cargo build --target wasm32-unknown-unknown --release"
        )
    });
    let contract = worker.dev_deploy(&wasm).await?;

    // Sponsor storage generously from the sandbox root account.
    worker
        .root_account()?
        .transfer_near(contract.id(), NearToken::from_near(1_000))
        .await?
        .into_result()?;

    let root = contract.as_account();
    let operator = root
        .create_subaccount("operator")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;
    let resolver = root
        .create_subaccount("resolver")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;
    let buyer = root
        .create_subaccount("buyer")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;

    let res = contract
        .call("new")
        .args_json(serde_json::json!({ "operator": operator.id() }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "init failed: {res:?}");

    Ok((worker, contract, operator, resolver, buyer))
}

fn spec_json(
    resolver_id: &str,
    open_time: u64,
    close_time: u64,
    obs_start: u64,
    obs_end: u64,
    resolve_deadline: u64,
    reveal_window: u64,
    access_price: u128,
    min_stake: u128,
) -> serde_json::Value {
    // create_question(spec: QuestionSpec) — the struct is nested under `spec`.
    serde_json::json!({
        "spec": {
            "text": "Will it rain?",
            "event_definition": "precipitation_sum >= 1.0 mm",
            "source": "open-meteo ECMWF IFS 9km",
            "resolver": resolver_id,
            "open_time": open_time.to_string(),
            "close_time": close_time.to_string(),
            "observation_start": obs_start.to_string(),
            "observation_end": obs_end.to_string(),
            "resolve_time": serde_json::Value::Null,
            "resolve_deadline": resolve_deadline.to_string(),
            "reveal_window": reveal_window.to_string(),
            "access_price": access_price.to_string(),
            "min_stake": min_stake.to_string(),
        }
    })
}

#[tokio::test]
async fn test_full_lifecycle_64_participants_with_gas() -> anyhow::Result<()> {
    let (worker, contract, operator, resolver, buyer) = deploy().await?;

    // Pre-create all 64 participant accounts BEFORE the commitment window so
    // account-creation transactions cannot consume the open/close window.
    let mut participants: Vec<Account> = Vec::new();
    for i in 0..64u32 {
        let name = format!("p{i}");
        let acct = contract
            .as_account()
            .create_subaccount(&name)
            .initial_balance(NearToken::from_near(10))
            .transact()
            .await?
            .into_result()?;
        participants.push(acct);
    }

    // Generous virtual schedule anchored to the OBSERVED sandbox timestamp
    // AFTER participant setup, so 64 real RPC transactions each advancing the
    // block clock cannot expire the commit/reveal windows. All phase
    // transitions are reached via advance_to using observed timestamps.
    let t0 = worker.view_block().await?.timestamp();
    let open_time = t0 + 30 * NEAR_NS;
    let close_time = t0 + 900 * NEAR_NS;
    let obs_start = t0 + 960 * NEAR_NS;
    let obs_end = t0 + 980 * NEAR_NS;
    let resolve_deadline = t0 + 1300 * NEAR_NS;
    let reveal_window = 900 * NEAR_NS;
    let access_price: u128 = 5;
    let min_stake: u128 = 1;

    // 1. create_question (operator-only).
    let res = operator
        .call(contract.id(), "create_question")
        .args_json(spec_json(
            resolver.id().as_str(),
            open_time,
            close_time,
            obs_start,
            obs_end,
            resolve_deadline,
            reveal_window,
            access_price,
            min_stake,
        ))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "create_question failed: {res:?}");
    let question_id: u64 = res.json()?;

    // 2. commit all 64 participants (stake = min_stake each).
    advance_to(&worker, open_time).await?;
    for (i, acct) in participants.iter().enumerate() {
        let hash = commitment_hash(
            contract.id().as_str(),
            question_id,
            acct.id().as_str(),
            min_stake,
            5000,
            "salt",
        );
        let res = acct
            .call(contract.id(), "commit")
            .args_json(serde_json::json!({ "question_id": question_id, "hash": hash }))
            .deposit(NearToken::from_yoctonear(min_stake))
            .max_gas()
            .transact()
            .await?;
        assert!(res.is_success(), "commit {i} failed: {res:?}");
    }

    // 3. publish snapshot + buy (exactly access_price).
    advance_to(&worker, close_time + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "publish_snapshot")
        .args_json(serde_json::json!({ "question_id": question_id, "snapshot_id": "snapshot-1" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "publish_snapshot failed: {res:?}");

    let res = buyer
        .call(contract.id(), "buy_forecast")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .deposit(NearToken::from_yoctonear(access_price))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "buy_forecast failed: {res:?}");

    // 4. resolve YES (resolver-only).
    advance_to(&worker, obs_end + 2 * NEAR_NS).await?;
    let res = resolver
        .call(contract.id(), "resolve")
        .args_json(serde_json::json!({ "question_id": question_id, "outcome": true }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "resolve failed: {res:?}");

    // 5. reveal all 64 (matching commitment).
    for acct in &participants {
        let res = acct
            .call(contract.id(), "reveal")
            .args_json(serde_json::json!({
                "question_id": question_id,
                "prob_bps": 5000,
                "salt": "salt"
            }))
            .max_gas()
            .transact()
            .await?;
        assert!(res.is_success(), "reveal failed: {res:?}");
    }

    // 6. settle after reveal deadline, measuring real gas.
    let resolved_at = worker.view_block().await?.timestamp();
    advance_to(&worker, resolved_at + reveal_window + 2 * NEAR_NS).await?;
    let settle_res = operator
        .call(contract.id(), "settle")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(settle_res.is_success(), "settle failed: {settle_res:?}");
    let gas_burnt = settle_res.total_gas_burnt.as_gas();
    eprintln!("SETTLE_GAS_64_PARTICIPANTS={gas_burnt}");
    assert!(
        gas_burnt < MAX_SETTLE_GAS,
        "settlement gas {gas_burnt} exceeds {MAX_SETTLE_GAS}"
    );

    // 7. Exact conservation: total claimable = W + F = 64 + 5 = 69.
    let mut total: u128 = 0;
    for acct in &participants {
        let bal: serde_json::Value = contract
            .call("get_balance")
            .args_json(serde_json::json!({ "account_id": acct.id() }))
            .view()
            .await?
            .json()?;
        let claimable: u128 = bal["claimable"]
            .as_str()
            .expect("claimable is a string")
            .parse()?;
        total += claimable;
    }
    assert_eq!(total, 64 + access_price, "stake+fee conservation violated");

    Ok(())
}

#[tokio::test]
async fn test_withdraw_delivers_funds() -> anyhow::Result<()> {
    let (worker, contract, operator, resolver, buyer) = deploy().await?;

    let participant = contract
        .as_account()
        .create_subaccount("solo")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;

    let t0 = worker.view_block().await?.timestamp();
    let open_time = t0 + 30 * NEAR_NS;
    let close_time = t0 + 900 * NEAR_NS;
    let obs_start = t0 + 960 * NEAR_NS;
    let obs_end = t0 + 980 * NEAR_NS;
    let resolve_deadline = t0 + 1300 * NEAR_NS;
    let reveal_window = 900 * NEAR_NS;
    // NEAR-scale amounts so recipient balance change is observable over gas.
    let min_stake: u128 = 10_000_000_000_000_000_000_000_000; // 10 NEAR
    let access_price: u128 = 5_000_000_000_000_000_000_000_000; // 5 NEAR

    let res = operator
        .call(contract.id(), "create_question")
        .args_json(spec_json(
            resolver.id().as_str(),
            open_time,
            close_time,
            obs_start,
            obs_end,
            resolve_deadline,
            reveal_window,
            access_price,
            min_stake,
        ))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "create_question failed: {res:?}");
    let question_id: u64 = res.json()?;

    advance_to(&worker, open_time).await?;
    let hash = commitment_hash(
        contract.id().as_str(),
        question_id,
        participant.id().as_str(),
        min_stake,
        5000,
        "salt",
    );
    let res = participant
        .call(contract.id(), "commit")
        .args_json(serde_json::json!({ "question_id": question_id, "hash": hash }))
        .deposit(NearToken::from_yoctonear(min_stake))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "commit failed: {res:?}");

    advance_to(&worker, close_time + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "publish_snapshot")
        .args_json(serde_json::json!({ "question_id": question_id, "snapshot_id": "snap" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "publish_snapshot failed: {res:?}");
    let res = buyer
        .call(contract.id(), "buy_forecast")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .deposit(NearToken::from_yoctonear(access_price))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "buy_forecast failed: {res:?}");

    advance_to(&worker, obs_end + 2 * NEAR_NS).await?;
    let res = resolver
        .call(contract.id(), "resolve")
        .args_json(serde_json::json!({ "question_id": question_id, "outcome": true }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "resolve failed: {res:?}");

    let res = participant
        .call(contract.id(), "reveal")
        .args_json(serde_json::json!({
            "question_id": question_id,
            "prob_bps": 5000,
            "salt": "salt"
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "reveal failed: {res:?}");

    let resolved_at = worker.view_block().await?.timestamp();
    advance_to(&worker, resolved_at + reveal_window + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "settle")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "settle failed: {res:?}");

    // Single participant: base = stake back (10), fee = entire pool (5) → 15 NEAR.
    let bal: serde_json::Value = contract
        .call("get_balance")
        .args_json(serde_json::json!({ "account_id": participant.id() }))
        .view()
        .await?
        .json()?;
    assert_eq!(bal["claimable"].as_str().unwrap(), "15000000000000000000000000");

    let before = participant.view_account().await?.balance;

    // withdraw(amount: U128) — decimal string.
    let res = participant
        .call(contract.id(), "withdraw")
        .args_json(serde_json::json!({ "amount": "15000000000000000000000000" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "withdraw failed: {res:?}");

    // Callback ran: pending cleared, received = 15 NEAR.
    let bal: serde_json::Value = contract
        .call("get_balance")
        .args_json(serde_json::json!({ "account_id": participant.id() }))
        .view()
        .await?
        .json()?;
    assert_eq!(bal["claimable"].as_str().unwrap(), "0");
    assert_eq!(bal["pending"].as_str().unwrap(), "0");
    assert_eq!(bal["received"].as_str().unwrap(), "15000000000000000000000000");

    // Recipient balance actually increased (15 NEAR - gas >> 0).
    let after = participant.view_account().await?.balance;
    assert!(
        after.as_yoctonear() > before.as_yoctonear(),
        "recipient balance did not increase: before={before:?} after={after:?}"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Real native scenarios required by #4 acceptance-5 and #7 acceptance-1:
// zero-valid-reveal fee refund and an actual node-level transfer failure
// (pending → restored, private callback denied, safe retry delivery).
// ---------------------------------------------------------------------------

const STAKE_10: u128 = 10_000_000_000_000_000_000_000_000; // 10 NEAR
const STAKE_20: u128 = 20_000_000_000_000_000_000_000_000; // 20 NEAR
const FEE_5: u128 = 5_000_000_000_000_000_000_000_000; // 5 NEAR

/// Drive a single-participant Round to settlement (stake 10, fee 5 → claimable
/// 15 NEAR) and return the participant account and question id.
async fn settle_single_participant(
    worker: &Worker<Sandbox>,
    contract: &Contract,
    operator: &Account,
    resolver: &Account,
    buyer: &Account,
) -> anyhow::Result<(Account, u64)> {
    let participant = contract
        .as_account()
        .create_subaccount("solo")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;

    let t0 = worker.view_block().await?.timestamp();
    let open_time = t0 + 30 * NEAR_NS;
    let close_time = t0 + 900 * NEAR_NS;
    let obs_start = t0 + 960 * NEAR_NS;
    let obs_end = t0 + 980 * NEAR_NS;
    let resolve_deadline = t0 + 1300 * NEAR_NS;
    let reveal_window = 900 * NEAR_NS;

    let res = operator
        .call(contract.id(), "create_question")
        .args_json(spec_json(
            resolver.id().as_str(),
            open_time,
            close_time,
            obs_start,
            obs_end,
            resolve_deadline,
            reveal_window,
            FEE_5,
            STAKE_10,
        ))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "create_question failed: {res:?}");
    let question_id: u64 = res.json()?;

    advance_to(worker, open_time).await?;
    let hash = commitment_hash(
        contract.id().as_str(),
        question_id,
        participant.id().as_str(),
        STAKE_10,
        5000,
        "salt",
    );
    let res = participant
        .call(contract.id(), "commit")
        .args_json(serde_json::json!({ "question_id": question_id, "hash": hash }))
        .deposit(NearToken::from_yoctonear(STAKE_10))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "commit failed: {res:?}");

    advance_to(worker, close_time + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "publish_snapshot")
        .args_json(serde_json::json!({ "question_id": question_id, "snapshot_id": "snap" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "publish_snapshot failed: {res:?}");
    let res = buyer
        .call(contract.id(), "buy_forecast")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .deposit(NearToken::from_yoctonear(FEE_5))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "buy_forecast failed: {res:?}");

    advance_to(worker, obs_end + 2 * NEAR_NS).await?;
    let res = resolver
        .call(contract.id(), "resolve")
        .args_json(serde_json::json!({ "question_id": question_id, "outcome": true }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "resolve failed: {res:?}");

    let res = participant
        .call(contract.id(), "reveal")
        .args_json(serde_json::json!({
            "question_id": question_id,
            "prob_bps": 5000,
            "salt": "salt"
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "reveal failed: {res:?}");

    let resolved_at = worker.view_block().await?.timestamp();
    advance_to(worker, resolved_at + reveal_window + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "settle")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "settle failed: {res:?}");

    Ok((participant, question_id))
}

#[tokio::test]
async fn test_zero_reveal_refunds_fee_and_stakes_natively() -> anyhow::Result<()> {
    let (worker, contract, operator, resolver, buyer) = deploy().await?;

    // Two agents, no reveal after a real resolve + full reveal deadline.
    let a = contract
        .as_account()
        .create_subaccount("za")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;
    let b = contract
        .as_account()
        .create_subaccount("zb")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;

    let t0 = worker.view_block().await?.timestamp();
    let open_time = t0 + 30 * NEAR_NS;
    let close_time = t0 + 900 * NEAR_NS;
    let obs_start = t0 + 960 * NEAR_NS;
    let obs_end = t0 + 980 * NEAR_NS;
    let resolve_deadline = t0 + 1300 * NEAR_NS;
    let reveal_window = 900 * NEAR_NS;

    let res = operator
        .call(contract.id(), "create_question")
        .args_json(spec_json(
            resolver.id().as_str(),
            open_time,
            close_time,
            obs_start,
            obs_end,
            resolve_deadline,
            reveal_window,
            FEE_5,
            STAKE_10,
        ))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "create_question failed: {res:?}");
    let question_id: u64 = res.json()?;

    advance_to(&worker, open_time).await?;
    for (acct, stake) in [(&a, STAKE_10), (&b, STAKE_20)] {
        let hash = commitment_hash(
            contract.id().as_str(),
            question_id,
            acct.id().as_str(),
            stake,
            5000,
            "salt",
        );
        let res = acct
            .call(contract.id(), "commit")
            .args_json(serde_json::json!({ "question_id": question_id, "hash": hash }))
            .deposit(NearToken::from_yoctonear(stake))
            .max_gas()
            .transact()
            .await?;
        assert!(res.is_success(), "commit failed: {res:?}");
    }

    advance_to(&worker, close_time + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "publish_snapshot")
        .args_json(serde_json::json!({ "question_id": question_id, "snapshot_id": "snap" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "publish_snapshot failed: {res:?}");
    let res = buyer
        .call(contract.id(), "buy_forecast")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .deposit(NearToken::from_yoctonear(FEE_5))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "buy_forecast failed: {res:?}");

    advance_to(&worker, obs_end + 2 * NEAR_NS).await?;
    let res = resolver
        .call(contract.id(), "resolve")
        .args_json(serde_json::json!({ "question_id": question_id, "outcome": true }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "resolve failed: {res:?}");

    // Deliberately NO reveal from either agent; wait the full reveal window.
    let resolved_at = worker.view_block().await?.timestamp();
    advance_to(&worker, resolved_at + reveal_window + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "settle")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "settle failed: {res:?}");

    // Zero valid reveal: base returns original stakes, no fee to agents.
    let a_bal: serde_json::Value = contract
        .call("get_balance")
        .args_json(serde_json::json!({ "account_id": a.id() }))
        .view()
        .await?
        .json()?;
    let b_bal: serde_json::Value = contract
        .call("get_balance")
        .args_json(serde_json::json!({ "account_id": b.id() }))
        .view()
        .await?
        .json()?;
    assert_eq!(a_bal["claimable"].as_str().unwrap(), "10000000000000000000000000");
    assert_eq!(b_bal["claimable"].as_str().unwrap(), "20000000000000000000000000");

    // Buyer claims their fee refund exactly once and receives the funds.
    let res = buyer
        .call(contract.id(), "claim_buyer_refund")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "claim_buyer_refund failed: {res:?}");

    let buyer_before = buyer.view_account().await?.balance;
    let res = buyer
        .call(contract.id(), "withdraw")
        .args_json(serde_json::json!({ "amount": "5000000000000000000000000" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "buyer withdraw failed: {res:?}");
    let buyer_after = buyer.view_account().await?.balance;
    assert!(
        buyer_after.as_yoctonear() > buyer_before.as_yoctonear(),
        "buyer balance did not increase: before={buyer_before:?} after={buyer_after:?}"
    );

    // Each agent withdraws their original stake exactly (native delivery).
    for (acct, expect) in [(&a, "10000000000000000000000000"), (&b, "20000000000000000000000000")] {
        let before = acct.view_account().await?.balance;
        let res = acct
            .call(contract.id(), "withdraw")
            .args_json(serde_json::json!({ "amount": expect }))
            .max_gas()
            .transact()
            .await?;
        assert!(res.is_success(), "agent withdraw failed: {res:?}");
        let after = acct.view_account().await?.balance;
        assert!(
            after.as_yoctonear() > before.as_yoctonear(),
            "agent balance did not increase: before={before:?} after={after:?}"
        );
        let bal: serde_json::Value = contract
            .call("get_balance")
            .args_json(serde_json::json!({ "account_id": acct.id() }))
            .view()
            .await?
            .json()?;
        assert_eq!(bal["received"].as_str().unwrap(), expect);
    }

    // Second refund claim must be rejected (exactly-once).
    let res = buyer
        .call(contract.id(), "claim_buyer_refund")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure(), "second claim_buyer_refund must fail: {res:?}");

    Ok(())
}

#[tokio::test]
async fn test_withdraw_transfer_failure_restores_and_retry_delivers() -> anyhow::Result<()> {
    let (worker, contract, operator, resolver, buyer) = deploy().await?;
    let (participant, _qid) =
        settle_single_participant(&worker, &contract, &operator, &resolver, &buyer).await?;

    // Claimable is 15 NEAR after settlement.
    let bal: serde_json::Value = contract
        .call("get_balance")
        .args_json(serde_json::json!({ "account_id": participant.id() }))
        .view()
        .await?
        .json()?;
    assert_eq!(bal["claimable"].as_str().unwrap(), "15000000000000000000000000");

    let pid = participant.id().clone();

    // Submit the withdraw asynchronously (broadcast_tx_async: accepted but the
    // transfer receipt is deferred to a later block), then delete the recipient
    // account so the node-level Transfer action fails with AccountDoesNotExist.
    let wd_status = participant
        .call(contract.id(), "withdraw")
        .args_json(serde_json::json!({ "amount": "15000000000000000000000000" }))
        .max_gas()
        .transact_async()
        .await?;

    // Delete the participant (its leftover balance goes to the buyer). The
    // contract still holds the 15 NEAR entitlement keyed by the account id.
    participant.delete_account(buyer.id()).await?;

    // Wait for the withdraw's final outcome (transfer + private callback).
    let outcome = wd_status.await?;
    eprintln!("WITHDRAW_FAILURE_OUTCOME={outcome:?}");

    // Ledger: pending restored to claimable, nothing received.
    let bal: serde_json::Value = contract
        .call("get_balance")
        .args_json(serde_json::json!({ "account_id": pid }))
        .view()
        .await?
        .json()?;
    assert_eq!(bal["claimable"].as_str().unwrap(), "15000000000000000000000000");
    assert_eq!(bal["pending"].as_str().unwrap(), "0");
    assert_eq!(bal["received"].as_str().unwrap(), "0");

    // Safe retry: recreate the same-named account and withdraw again; the
    // restored entitlement delivers exactly once (no double spend).
    let participant2 = contract
        .as_account()
        .create_subaccount("solo")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?;

    let before = participant2.view_account().await?.balance;
    let res = participant2
        .call(contract.id(), "withdraw")
        .args_json(serde_json::json!({ "amount": "15000000000000000000000000" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "retry withdraw failed: {res:?}");

    let after = participant2.view_account().await?.balance;
    assert!(
        after.as_yoctonear() > before.as_yoctonear(),
        "retry recipient balance did not increase: before={before:?} after={after:?}"
    );

    let bal: serde_json::Value = contract
        .call("get_balance")
        .args_json(serde_json::json!({ "account_id": participant2.id() }))
        .view()
        .await?
        .json()?;
    assert_eq!(bal["claimable"].as_str().unwrap(), "0");
    assert_eq!(bal["received"].as_str().unwrap(), "15000000000000000000000000");

    Ok(())
}

#[tokio::test]
async fn test_private_callback_denied_natively() -> anyhow::Result<()> {
    let (worker, contract, operator, resolver, buyer) = deploy().await?;
    let (participant, _qid) =
        settle_single_participant(&worker, &contract, &operator, &resolver, &buyer).await?;

    // Produce a real pending-withdrawal nonce (0) via a successful withdraw.
    let res = participant
        .call(contract.id(), "withdraw")
        .args_json(serde_json::json!({ "amount": "15000000000000000000000000" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "withdraw failed: {res:?}");

    // A non-contract account must not be able to drive the private callback,
    // even for an existing nonce. The #[private] guard rejects at the node.
    let res = buyer
        .call(contract.id(), "on_withdraw_callback")
        .args_json(serde_json::json!({ "nonce": 0 }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure(), "private callback must be denied: {res:?}");

    Ok(())
}
