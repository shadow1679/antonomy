//! Randomness as a service on the product contract in a local NEAR sandbox,
//! with the gasbench contract as a demo consumer: it holds $ANTO, asks for a
//! value with `draw` (a cross-contract `request_randomness`), and reads it back
//! with `collect` (a cross-contract `randomness_value`) once someone proved the
//! request's drand round. The sandbox runs on the real clock, so the proof is a
//! real quicknet beacon fetched with curl (`tests/common/mod.rs`), and the
//! value is re-derived here with the sim crate's own sha256 as a check of the
//! hash layout in `token/src/random.rs`. Build both wasms first:
//!
//!   cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
//!   cargo near build non-reproducible-wasm --manifest-path sim/gasbench/Cargo.toml
//!   cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml --test random -- --nocapture

use antosim::sha256;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

mod common;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const PRODUCT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../contract/target/near/antonomy_contract.wasm"
);
const CONSUMER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/antosim_gasbench.wasm");
const TGAS: f64 = 1e12;
const ONE: u128 = 1_000_000_000_000_000_000_000_000;

/// The largest gas any receipt of the call burned, and their sum.
fn gas(r: &ExecutionFinalResult) -> (f64, f64) {
    let all: Vec<u64> = r.receipt_outcomes().iter().map(|o| o.gas_burnt.as_gas()).collect();
    (
        all.iter().copied().max().unwrap_or(0) as f64 / TGAS,
        all.iter().sum::<u64>() as f64 / TGAS,
    )
}

async fn call(who: &Account, to: &Contract, method: &str, args: Value) -> Res<ExecutionFinalResult> {
    let r = who.call(to.id(), method).args_json(args).max_gas().transact().await?;
    if r.is_failure() {
        return Err(format!("{method} failed: {:?}", r.failures()).into());
    }
    let (worst, total) = gas(&r);
    println!("  {method:<20} worst receipt {worst:6.2} TGas, all {total:6.2} TGas");
    Ok(r)
}

async fn balance(c: &Contract, who: &str) -> Res<u128> {
    let v: String = c.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

async fn request(c: &Contract, id: u64) -> Res<Value> {
    Ok(c.view("randomness_request").args_json(json!({"id": id})).await?.json()?)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// The spec in `token/src/random.rs`, written out again.
fn expected(randomness: &str, id: u64, requester: &str, contract: &str) -> String {
    let mut buf = b"ANTO-RAND-v1".to_vec();
    buf.extend_from_slice(&unhex(randomness));
    buf.extend_from_slice(&id.to_be_bytes());
    for a in [requester, contract] {
        buf.extend_from_slice(&(a.len() as u16).to_be_bytes());
        buf.extend_from_slice(a.as_bytes());
    }
    hex(&sha256(&buf))
}

#[tokio::test]
async fn a_consumer_contract_requests_and_reads_randomness() -> Res<()> {
    let wasm = std::fs::read(PRODUCT).map_err(|e| format!("{PRODUCT}: {e}. Build the contract first."))?;
    let consumer_wasm =
        std::fs::read(CONSUMER).map_err(|e| format!("{CONSUMER}: {e}. Build the gasbench first."))?;
    let worker = near_workspaces::sandbox().await?;
    let oracle = worker.dev_deploy(&wasm).await?;
    let consumer = worker.dev_deploy(&consumer_wasm).await?;
    let treasury = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;

    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;
    oracle
        .call("new")
        .args_json(json!({
            "treasury": treasury.id(), "guardian": treasury.id(),
            "total_supply": (1_000_000 * ONE).to_string(), "cap_per_wallet": (100 * ONE).to_string(),
            "close_at_ms": now_ms + 600_000, "publish_at_ms": now_ms + 1_200_000,
            "keepers": [treasury.id()], "quorum": 1,
            "request_config": {
                "fee": (100 * ONE).to_string(), "keeper_bps": 2000, "agent_bps": 3000, "crank_bps": 1000,
                "odds_window_ms": 600_000u64, "forecast_window_ms": 60_000u64,
                "agent_deposit": (10 * ONE).to_string(), "crank_bounty": "0"
            },
            "round_config": {"stake_ms": 8_000u64, "gap_ms": 4_000u64},
            "faucet_amount": (100 * ONE).to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let config: Value = oracle.view("randomness_config").await?.json()?;
    println!("\nwasm size {} bytes\nconfig {config}", wasm.len());
    assert_eq!(config["fee"], ONE.to_string());

    // The consumer needs $ANTO for the fee. The treasury sends it some.
    let r = treasury
        .call(oracle.id(), "ft_transfer")
        .args_json(json!({"receiver_id": consumer.id(), "amount": (5 * ONE).to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let supply: String = oracle.view("ft_total_supply").await?.json()?;

    println!("the consumer asks:");
    // Without $ANTO a request fails and nothing is stored.
    assert!(call(&alice, &oracle, "request_randomness", json!({})).await.is_err(), "no balance");
    let n: u64 = oracle.view("randomness_count").await?.json()?;
    assert_eq!(n, 0);
    let _ = call(&alice, &oracle, "claim_play_tokens", json!({})).await?;
    let _ = call(consumer.as_account(), &consumer, "draw", json!({"oracle": oracle.id()})).await?;
    let drawn: (Option<u64>, Option<String>) = consumer.view("drawn").await?.json()?;
    let id = drawn.0.expect("the consumer kept its request id");
    assert_eq!(drawn.1, None);
    assert_eq!(balance(&oracle, consumer.id().as_str()).await?, 4 * ONE, "the fee came from the consumer");
    let after: String = oracle.view("ft_total_supply").await?.json()?;
    assert_eq!(after.parse::<u128>()?, supply.parse::<u128>()? - ONE, "and was burned");

    // A second request, from a person.
    let id2: u64 = call(&alice, &oracle, "request_randomness", json!({})).await?.json()?;
    assert_eq!(id2, id + 1);

    let req = request(&oracle, id).await?;
    assert_eq!(req["status"], "pending");
    assert_eq!(req["requester"], consumer.id().as_str());
    // Reading early gives null.
    let _ = call(consumer.as_account(), &consumer, "collect", json!({"oracle": oracle.id()})).await?;
    let drawn: (Option<u64>, Option<String>) = consumer.view("drawn").await?.json()?;
    assert_eq!(drawn.1, None, "pending until the round is proven");

    println!("anyone proves the round(s):");
    let r1 = req["drand_round"].as_u64().unwrap();
    let r2 = request(&oracle, id2).await?["drand_round"].as_u64().unwrap();
    let mut rounds = vec![r1];
    if r2 != r1 {
        rounds.push(r2);
    }
    println!("  drand rounds {rounds:?}");
    for round in rounds {
        let sig = common::beacon(round);
        let _ = call(&alice, &oracle, "fulfill_randomness", json!({"drand_round": round, "drand_signature": sig})).await?;
        // Proving again is a free read.
        let _ = call(&alice, &oracle, "fulfill_randomness", json!({"drand_round": round})).await?;
    }
    // A round nobody asked for is refused.
    assert!(
        call(&alice, &oracle, "fulfill_randomness", json!({"drand_round": r1 + 1000, "drand_signature": "00".repeat(48)}))
            .await
            .is_err(),
        "no request waits"
    );

    println!("the consumer reads:");
    let _ = call(consumer.as_account(), &consumer, "collect", json!({"oracle": oracle.id()})).await?;
    let (cid, value) = consumer.view("drawn").await?.json::<(Option<u64>, Option<String>)>()?;
    let value = value.expect("ready after the proof");
    assert_eq!(cid, Some(id));
    let req = request(&oracle, id).await?;
    assert_eq!(req["status"], "ready");
    assert_eq!(value, req["value"].as_str().unwrap());
    assert_eq!(
        value,
        expected(req["randomness"].as_str().unwrap(), id, consumer.id().as_str(), oracle.id().as_str()),
        "the value follows the spec"
    );
    let req2 = request(&oracle, id2).await?;
    assert_ne!(req2["value"], req["value"], "each request has its own value");
    println!("  value {value}\n  matches the independent sha256 of the spec");
    Ok(())
}
