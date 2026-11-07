//! The round and the faucet on the product contract in a local NEAR sandbox:
//! play tokens from the faucet, keepers post the trending market, a wallet
//! stakes on it, an agent posts, three cranks run the market's colonies with
//! the stake and agent inputs, then `start_round` refunds the stake and opens
//! the next round. Gas of every call. The Burn colony cannot be tested here:
//! it only runs from 12:00 to 24:00 UTC and the sandbox clock is real time
//! (its gas is measured on testnet). Build first:
//!
//!   cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
//!   cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml --test round -- --nocapture

use antosim::{forecast_market, FORECAST_ANTS, FORECAST_TICKS};
use near_workspaces::result::ExecutionFinalResult;
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

fn call_gas(r: &ExecutionFinalResult) -> f64 {
    r.receipt_outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap_or(0) as f64
        / TGAS
}

async fn call(who: &Account, c: &Contract, method: &str, args: Value) -> Res<ExecutionFinalResult> {
    let r = who.call(c.id(), method).args_json(args).max_gas().transact().await?;
    if r.is_failure() {
        return Err(format!("{method} failed: {:?}", r.failures()).into());
    }
    println!("  {method:<22} {:7.2} TGas", call_gas(&r));
    Ok(r)
}

async fn balance(c: &Contract, who: &Account) -> Res<u128> {
    let v: String = c.view("ft_balance_of").args_json(json!({"account_id": who.id()})).await?.json()?;
    Ok(v.parse()?)
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

#[tokio::test]
async fn round_with_stake_agent_and_faucet() -> Res<()> {
    let wasm = std::fs::read(WASM).map_err(|e| format!("{WASM}: {e}. Build the contract first."))?;
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm).await?;
    let treasury = worker.dev_create_account().await?;
    let keeper = worker.dev_create_account().await?;
    let staker = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let cranker = worker.dev_create_account().await?;

    // The sandbox clock is real time. The first round closes in 12 s and its
    // agents' window ends 8 s later.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    c.call("new")
        .args_json(json!({
            "treasury": treasury.id(), "guardian": treasury.id(),
            "total_supply": (1_000_000 * ONE).to_string(), "cap_per_wallet": (100 * ONE).to_string(),
            "close_at_ms": now_ms + 12_000, "publish_at_ms": now_ms + 45_000,
            "keepers": [keeper.id()], "quorum": 1,
            "request_config": {
                "fee": (100 * ONE).to_string(), "keeper_bps": 2000, "agent_bps": 3000, "crank_bps": 1000,
                "odds_window_ms": 600_000u64, "forecast_window_ms": 4_000u64,
                "agent_deposit": (10 * ONE).to_string(), "crank_bounty": "0"
            },
            "round_config": {"stake_ms": 8_000u64, "gap_ms": 30_000u64},
            "faucet_amount": (100 * ONE).to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    println!("\nwasm size {} bytes\nfaucet:", wasm.len());
    let got: String = call(&staker, &c, "claim_play_tokens", json!({})).await?.json()?;
    assert_eq!(got, (100 * ONE).to_string());
    assert!(call(&staker, &c, "claim_play_tokens", json!({})).await.is_err(), "second claim");
    let _ = call(&agent, &c, "claim_play_tokens", json!({})).await?;
    assert_eq!(balance(&c, &staker).await?, 100 * ONE);

    println!("the round:");
    let market = json!({
        "market_id": "fed-decision", "outcomes": ["Cut", "Hold", "Hike"],
        "odds": [6200, 2800, 1000], "odds_6h": [5500, 3300, 1200], "raw_hash": "ab".repeat(32)
    });
    let _ = call(&keeper, &c, "post_trending", json!({"markets": [market]})).await?;
    let _ = call(&staker, &c, "stake", json!({"colony": 1, "option": 2, "amount": (36 * ONE).to_string()})).await?;
    assert_eq!(balance(&c, &staker).await?, 64 * ONE);
    let _ = call(&agent, &c, "register_agent", json!({})).await?;

    // Wait for the close, finalize, let the agent post, wait for the publish time.
    let mut ms = None;
    for _ in 0..40 {
        let r = cranker.call(c.id(), "finalize_markets").max_gas().transact().await?;
        if r.is_success() {
            ms = Some(r);
            break;
        }
        worker.fast_forward(3).await?;
    }
    let ms = ms.ok_or("finalize never succeeded")?;
    println!("  finalize_markets       {:7.2} TGas", call_gas(&ms));
    common::forecast(&worker, &c, &agent, 1, &[2000, 3000, 5000]).await?;

    // The first crank must carry the drand round the round committed to.
    let rs: Value = c.view("round_status").await?.json()?;
    let sig = common::beacon(rs["drand_round"].as_u64().ok_or("no drand round")?);
    let mut last = None;
    let (mut total, mut worst) = (0f64, 0f64);
    for _ in 0..60 {
        let r = cranker
            .call(c.id(), "crank_round")
            .args_json(json!({"drand_signature": sig}))
            .max_gas()
            .transact()
            .await?;
        if r.is_failure() {
            worker.fast_forward(3).await?;
            continue;
        }
        let g = call_gas(&r);
        total += g;
        worst = worst.max(g);
        let v: Value = r.json()?;
        let n = v["markets"][0]["colony_hashes"].as_array().unwrap().len();
        println!("  crank_round            {g:7.2} TGas  ({n} of 3)");
        if v["done"] == true {
            last = Some(v);
            break;
        }
    }
    let v = last.ok_or("round never finished")?;
    println!("  three cranks           {total:7.2} TGas in total, worst {worst:.2} TGas");

    // The browser's native run matches the chain.
    let m = &v["markets"][0];
    let w: Vec<u32> = serde_json::from_value(m["weights"].clone())?;
    assert!(w[2] > 0 && w[0] == 0, "Community read the stake: {w:?}");
    let odds: Vec<u16> = serde_json::from_value(m["agents"]["odds"].clone())?;
    assert_eq!(odds, vec![2000, 3000, 5000]);
    let markets: Value = c.view("forecast_markets").await?.json()?;
    let mk = &markets[0];
    let native = forecast_market(
        &hex32(v["seed"].as_str().unwrap()),
        1,
        &serde_json::from_value::<Vec<u16>>(mk["odds"].clone())?,
        &serde_json::from_value::<Vec<u16>>(mk["odds_6h"].clone())?,
        &w,
        hex32(v["stake_hash"].as_str().unwrap()),
        &odds,
        hex32(m["agents"]["hash"].as_str().unwrap()),
        FORECAST_ANTS,
        FORECAST_TICKS,
    )
    .map_err(|e| format!("{e:?}"))?;
    assert_eq!(m["market_hash"].as_str().unwrap(), native.hash_hex());
    println!("  market hash matches the native run; swarm {}", m["swarm"]);

    // Next round: wait for it to be allowed, then the stake comes back.
    let mut next = None;
    for _ in 0..20 {
        let r = cranker.call(c.id(), "start_round").max_gas().transact().await?;
        if r.is_success() {
            next = Some(r);
            break;
        }
        worker.fast_forward(3).await?;
    }
    let next = next.ok_or("start_round never succeeded")?;
    println!("  start_round            {:7.2} TGas", call_gas(&next));
    assert_eq!(next.json::<u64>()?, 1);
    assert_eq!(balance(&c, &staker).await?, 100 * ONE, "stake refunded");
    let st: Value = c.view("round_status").await?.json()?;
    assert_eq!((st["round"].as_u64(), st["phase"].as_str()), (Some(1), Some("posting")));
    Ok(())
}
