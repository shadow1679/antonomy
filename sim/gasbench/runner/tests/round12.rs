//! A full round at the contract's cap (12 markets, 60 colonies) in a local
//! NEAR sandbox: one keeper posts 12 five-outcome markets, `finalize_markets`
//! accepts them, and `crank_round` runs every colony. Gas of every call, and
//! the largest crank, since the stored run grows with each market. Build first:
//!
//!   cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
//!   cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml --test round12 -- --nocapture

use near_workspaces::result::ExecutionFinalResult;
use serde_json::{json, Value};

mod common;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../contract/target/near/antonomy_contract.wasm"
);
const TGAS: f64 = 1e12;
const ONE: u128 = 1_000_000_000_000_000_000_000_000;
const MARKETS: usize = 12;

fn gas(r: &ExecutionFinalResult) -> f64 {
    r.outcomes().iter().map(|o| o.gas_burnt.as_gas()).sum::<u64>() as f64 / TGAS
}

#[tokio::test]
async fn a_round_of_twelve_markets() -> Res<()> {
    let wasm = std::fs::read(WASM).map_err(|e| format!("{WASM}: {e}. Build the contract first."))?;
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm).await?;
    let treasury = worker.dev_create_account().await?;
    let keeper = worker.dev_create_account().await?;
    let cranker = worker.dev_create_account().await?;

    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;
    c.call("new")
        .args_json(json!({
            "treasury": treasury.id(), "guardian": treasury.id(),
            "total_supply": (1_000_000 * ONE).to_string(), "cap_per_wallet": (100 * ONE).to_string(),
            "close_at_ms": now_ms + 12_000, "publish_at_ms": now_ms + 20_000,
            "keepers": [keeper.id()], "quorum": 1,
            "request_config": {
                "fee": (100 * ONE).to_string(), "keeper_bps": 2000, "agent_bps": 3000, "crank_bps": 1000,
                "odds_window_ms": 600_000u64, "forecast_window_ms": 4_000u64,
                "agent_deposit": (10 * ONE).to_string(), "crank_bounty": "0"
            },
            "round_config": {"stake_ms": 8_000u64, "gap_ms": 4_000u64},
            "faucet_amount": (100 * ONE).to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let markets: Vec<Value> = (0..MARKETS)
        .map(|i| {
            json!({
                "market_id": format!("market-{i}-with-a-fairly-long-polymarket-event-slug-2026"),
                "outcomes": ["Alpha", "Bravo", "Charlie", "Delta", "Other"],
                "odds": [3000, 2500, 2000, 1500, 1000], "odds_6h": [2800, 2600, 2100, 1500, 1000],
                "raw_hash": "ab".repeat(32)
            })
        })
        .collect();
    let post = keeper.call(c.id(), "post_trending").args_json(json!({"markets": markets})).max_gas().transact().await?;
    assert!(post.is_success(), "post_trending: {:?}", post.failures());
    println!("\n{MARKETS} markets");
    println!("  post_trending          {:7.2} TGas", gas(&post));

    let mut fin = None;
    for _ in 0..40 {
        let r = cranker.call(c.id(), "finalize_markets").max_gas().transact().await?;
        if r.is_success() {
            fin = Some(r);
            break;
        }
        worker.fast_forward(3).await?;
    }
    let fin = fin.ok_or("finalize never succeeded")?;
    println!("  finalize_markets       {:7.2} TGas", gas(&fin));
    let ms: Value = fin.json()?;
    assert_eq!(ms.as_array().unwrap().len(), MARKETS);

    // The first crank must carry the drand round the round committed to.
    let rs: Value = c.view("round_status").await?.json()?;
    let sig = common::beacon(rs["drand_round"].as_u64().ok_or("no drand round")?);
    let (mut total, mut worst, mut n, mut done) = (0f64, 0f64, 0u32, false);
    for _ in 0..200 {
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
        let g = gas(&r);
        total += g;
        worst = worst.max(g);
        n += 1;
        let v: Value = r.json()?;
        if n == 1 || n == 30 || n == 60 {
            println!("  crank_round #{n:<2}        {g:7.2} TGas");
        }
        if v["done"] == true {
            done = true;
            break;
        }
    }
    assert!(done && n as usize == MARKETS * 5, "round finished after {n} cranks");
    println!("  {n} cranks               {total:7.2} TGas in total, worst {worst:.2} TGas");
    assert!(worst < 300.0, "a crank must fit the 300 TGas limit");

    let st: Value = c.view("round_status").await?.json()?;
    println!("  round_status phase     {}", st["phase"]);
    let start = cranker.call(c.id(), "start_round").max_gas().transact().await;
    if let Ok(r) = start {
        if r.is_success() {
            println!("  start_round            {:7.2} TGas", gas(&r));
        }
    }
    Ok(())
}
