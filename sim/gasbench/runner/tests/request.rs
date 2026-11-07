//! Recruit the swarm on the product contract in a local NEAR sandbox: one
//! requested forecast end to end, with the gas of every call. The point is the
//! crank: each call runs one forecast colony (60 ants, 300 ticks), and all three
//! must fit well inside 300 TGas. Build the product wasm first:
//!
//!   cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
//!   cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml --test request -- --nocapture
//!
//! Also checks that the market hash the contract stored is the native one,
//! with a holder's stake on the request feeding Community.

use antosim::{forecast_market, FORECAST_ANTS, FORECAST_TICKS};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

mod common;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../contract/target/near/antonomy_contract.wasm"
);
const TGAS: f64 = 1e12;
const ONE: u128 = 1_000_000_000_000_000_000_000_000;
const SLUG: &str = "fed-decision-in-december";

fn call_gas(r: &ExecutionFinalResult) -> f64 {
    r.receipt_outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap_or(0) as f64
        / TGAS
}

async fn call(who: &Account, c: &Contract, method: &str, args: Value) -> Res<ExecutionFinalResult> {
    let r = who
        .call(c.id(), method)
        .args_json(args)
        .max_gas()
        .transact()
        .await?;
    if r.is_failure() {
        return Err(format!("{method} failed: {:?}", r.failures()).into());
    }
    println!("  {method:<22} {:7.2} TGas", call_gas(&r));
    Ok(r)
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

#[tokio::test]
async fn requested_forecast() -> Res<()> {
    let wasm = std::fs::read(WASM).map_err(|e| {
        format!("{WASM}: {e}. Build it with: cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml")
    })?;
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm).await?;
    let treasury = worker.dev_create_account().await?;
    let keeper = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let cranker = worker.dev_create_account().await?;
    println!("\nwasm size {} bytes", wasm.len());

    // One keeper (quorum 1 of 1), so its post finalizes the odds at once.
    // The agents' window is short so the sandbox clock passes it quickly.
    c.call("new")
        .args_json(json!({
            "treasury": treasury.id(), "guardian": treasury.id(),
            "total_supply": (1_000_000 * ONE).to_string(), "cap_per_wallet": (100 * ONE).to_string(),
            "close_at_ms": 0u64, "publish_at_ms": 1u64,
            "keepers": [keeper.id()], "quorum": 1,
            "request_config": {
                "fee": (100 * ONE).to_string(), "keeper_bps": 2000, "agent_bps": 3000, "crank_bps": 1000,
                "odds_window_ms": 600_000u64, "forecast_window_ms": 4_000u64,
                "agent_deposit": (10 * ONE).to_string(), "crank_bounty": "0"
            },
            "round_config": {"stake_ms": 60_000u64, "gap_ms": 10_000u64},
            "faucet_amount": (100 * ONE).to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for to in [agent.id(), cranker.id()] {
        treasury
            .call(c.id(), "ft_transfer")
            .args_json(json!({"receiver_id": to, "amount": (200 * ONE).to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }

    println!("one requested forecast, 3 outcomes:");
    let id: u32 = call(&agent, &c, "request_forecast", json!({"market_id": SLUG})).await?.json()?;
    let post = json!({
        "market_id": SLUG, "outcomes": ["Cut", "Hold", "Hike"],
        "odds": [6200, 2800, 1000], "odds_6h": [5500, 3300, 1200], "raw_hash": "ab".repeat(32)
    });
    let _ = call(&keeper, &c, "post_request_odds", json!({"request_id": id, "market": post})).await?;
    let r: Value = call(&cranker, &c, "finalize_request_odds", json!({"request_id": id}))
        .await?
        .json()?;
    let colony = r["colony"].as_u64().unwrap();
    let _ = call(&agent, &c, "register_agent", json!({})).await?;
    let _ = call(&agent, &c, "post_forecast", json!({"colony": colony, "odds": [4500, 4000, 1500]})).await?;
    // A holder stakes on the request's colony during the agents' window.
    let _ = call(&cranker, &c, "stake", json!({"colony": colony, "option": 2, "amount": (25 * ONE).to_string()})).await?;

    // Wait out the agents' window, then crank three times.
    let mut done = None;
    let mut worst = 0f64;
    let mut total = 0f64;
    // The first crank must carry the drand round the request committed to.
    let sig = common::beacon(r["drand_round"].as_u64().ok_or("no drand round")?);
    for _ in 0..60 {
        let r = cranker
            .call(c.id(), "crank_request")
            .args_json(json!({"request_id": id, "drand_signature": sig}))
            .max_gas()
            .transact()
            .await?;
        if r.is_failure() {
            let msg = format!("{:?}", r.failures());
            assert!(msg.contains("PostingStillOpen"), "{msg}");
            worker.fast_forward(5).await?;
            continue;
        }
        let g = call_gas(&r);
        worst = worst.max(g);
        total += g;
        let v: Value = r.json()?;
        println!("  crank_request          {g:7.2} TGas  ({} of 3)", v["colony_hashes"].as_array().unwrap().len());
        if v["phase"] == "done" {
            done = Some(v);
            break;
        }
    }
    let v = done.ok_or("request never finished")?;
    println!("  three cranks           {total:7.2} TGas in total, worst {worst:.2} TGas");

    let m = &v["market"];
    let odds: Vec<u16> = serde_json::from_value(m["odds"].clone())?;
    let odds_6h: Vec<u16> = serde_json::from_value(m["odds_6h"].clone())?;
    let ag = &v["agents"];
    let agent_odds: Vec<u16> = serde_json::from_value(ag["odds"].clone())?;
    let st = &v["stakes"];
    let weights: Vec<u32> = serde_json::from_value(st["weights"].clone())?;
    assert_eq!(weights, vec![0, 0, 5_000], "Community read the stake");
    let native = forecast_market(
        &hex32(v["seed"].as_str().unwrap()),
        colony as u16,
        &odds,
        &odds_6h,
        &weights,
        hex32(st["hash"].as_str().unwrap()),
        &agent_odds,
        hex32(ag["hash"].as_str().unwrap()),
        FORECAST_ANTS,
        FORECAST_TICKS,
    )
    .map_err(|e| format!("{e:?}"))?;
    assert_eq!(v["market_hash"].as_str().unwrap(), native.hash_hex());
    println!("  market hash matches the native run; swarm {:?}", v["swarm"]);
    Ok(())
}
