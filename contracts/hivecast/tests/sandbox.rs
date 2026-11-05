//! Real near-sandbox integration tests for the HiveCast contract.
//!
//! These tests compile the actual contract WASM (`near_workspaces::compile_project`)
//! and deploy it to a local `near-sandbox` node, then exercise the full public
//! lifecycle through real transactions — not the near-sdk mock VM and not a
//! mocked chain success. They also measure real settlement gas for a
//! 64-participant Round.
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

/// Advance the sandbox clock to at least `target_ns` by fast-forwarding the
/// required number of 1-second blocks (reading the current block timestamp).
async fn advance_to(worker: &Worker<Sandbox>, target_ns: u64) -> anyhow::Result<()> {
    let cur = worker.view_block().await?.timestamp();
    if cur >= target_ns {
        return Ok(());
    }
    let delta = target_ns - cur;
    let blocks = delta.div_ceil(NEAR_NS) + 2;
    worker.fast_forward(blocks).await?;
    Ok(())
}

/// Deploy the contract, fund it for storage sponsorship, and create the
/// operator, resolver, and buyer subaccounts.
async fn deploy() -> anyhow::Result<(Worker<Sandbox>, Contract, Account, Account, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = near_workspaces::compile_project(env!("CARGO_MANIFEST_DIR")).await?;
    let contract = worker.dev_deploy(&wasm).await?;

    // Sponsor storage generously from the sandbox root account.
    worker
        .root_account()?
        .transfer_near(contract.id(), NearToken::from_near(1_000))
        .await?;

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

    // Generous virtual schedule anchored to the current sandbox timestamp.
    let t0 = worker.view_block().await?.timestamp();
    let open_time = t0 + 200 * NEAR_NS;
    let close_time = t0 + 600 * NEAR_NS;
    let obs_start = t0 + 700 * NEAR_NS;
    let obs_end = t0 + 720 * NEAR_NS;
    let resolve_deadline = t0 + 1000 * NEAR_NS;
    let reveal_window = 600 * NEAR_NS;
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
    let open_time = t0 + 200 * NEAR_NS;
    let close_time = t0 + 600 * NEAR_NS;
    let obs_start = t0 + 700 * NEAR_NS;
    let obs_end = t0 + 720 * NEAR_NS;
    let resolve_deadline = t0 + 1000 * NEAR_NS;
    let reveal_window = 600 * NEAR_NS;
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
    assert!(res.is_success());
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
    assert!(res.is_success());

    advance_to(&worker, close_time + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "publish_snapshot")
        .args_json(serde_json::json!({ "question_id": question_id, "snapshot_id": "snap" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());
    let res = buyer
        .call(contract.id(), "buy_forecast")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .deposit(NearToken::from_yoctonear(access_price))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

    advance_to(&worker, obs_end + 2 * NEAR_NS).await?;
    let res = resolver
        .call(contract.id(), "resolve")
        .args_json(serde_json::json!({ "question_id": question_id, "outcome": true }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

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
    assert!(res.is_success());

    let resolved_at = worker.view_block().await?.timestamp();
    advance_to(&worker, resolved_at + reveal_window + 2 * NEAR_NS).await?;
    let res = operator
        .call(contract.id(), "settle")
        .args_json(serde_json::json!({ "question_id": question_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success());

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
