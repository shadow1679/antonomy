//! Keeper, contract and token end to end in a local NEAR sandbox. The keeper
//! is the real `keeper/trending.py` reading live Polymarket for a requested
//! event; its `--request` output is posted to the contract unchanged. Then the
//! agents' window, five cranks, the fee split in $ANTO, and the market hash
//! checked against the native run. Needs network, so it is ignored by default:
//!
//!   cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
//!   ANTO_E2E_SLUG=<open polymarket event slug> \
//!     cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml --test e2e -- --ignored --nocapture

use antosim::{forecast_market, FORECAST_ANTS, FORECAST_TICKS};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use std::process::Command;

mod common;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../contract/target/near/antonomy_contract.wasm"
);
const KEEPER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../keeper/trending.py");
const ONE: u128 = 1_000_000_000_000_000_000_000_000;
const DEFAULT_SLUG: &str = "fed-decision-in-october-20260617190323537";

async fn call(who: &Account, c: &Contract, method: &str, args: Value) -> Res<ExecutionFinalResult> {
    let r = who.call(c.id(), method).args_json(args).max_gas().transact().await?;
    if r.is_failure() {
        return Err(format!("{method} failed: {:?}", r.failures()).into());
    }
    Ok(r)
}

async fn balance(c: &Contract, who: &Account) -> Res<u128> {
    let v: String = c.view("ft_balance_of").args_json(json!({"account_id": who.id()})).await?.json()?;
    Ok(v.parse()?)
}

async fn supply(c: &Contract) -> Res<u128> {
    let v: String = c.view("ft_total_supply").await?.json()?;
    Ok(v.parse()?)
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

/// Run the keeper for a requested slug and return its `market` argument.
fn keeper_post(request_id: u32, slug: &str) -> Res<Value> {
    let out = Command::new("python3")
        .args(["-I", KEEPER, "--request", &request_id.to_string(), "--market", slug])
        .output()?;
    if !out.status.success() {
        return Err(format!(
            "keeper refused {slug}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )
        .into());
    }
    let v: Value = serde_json::from_slice(&out.stdout)?;
    assert_eq!(v["request_id"], request_id);
    Ok(v["market"].clone())
}

#[tokio::test]
#[ignore = "reads live Polymarket through the keeper"]
async fn keeper_contract_token() -> Res<()> {
    let slug = std::env::var("ANTO_E2E_SLUG").unwrap_or_else(|_| DEFAULT_SLUG.to_string());
    let wasm = std::fs::read(WASM).map_err(|e| format!("{WASM}: {e}. Build the contract first."))?;
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm).await?;
    let treasury = worker.dev_create_account().await?;
    let keeper = worker.dev_create_account().await?;
    let requester = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let cranker = worker.dev_create_account().await?;

    let fee = 100 * ONE;
    let deposit = 10 * ONE;
    let supply0 = 1_000_000 * ONE;
    c.call("new")
        .args_json(json!({
            "treasury": treasury.id(), "guardian": treasury.id(),
            "total_supply": supply0.to_string(), "cap_per_wallet": (100 * ONE).to_string(),
            "close_at_ms": 0u64, "publish_at_ms": 1u64,
            "keepers": [keeper.id()], "quorum": 1,
            "request_config": {
                "fee": fee.to_string(), "keeper_bps": 2000, "agent_bps": 3000, "crank_bps": 1000,
                "odds_window_ms": 600_000u64, "forecast_window_ms": 4_000u64,
                "agent_deposit": deposit.to_string(), "crank_bounty": "0"
            },
            "round_config": {"stake_ms": 60_000u64, "gap_ms": 10_000u64},
            "faucet_amount": (100 * ONE).to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for to in [requester.id(), agent.id()] {
        treasury
            .call(c.id(), "ft_transfer")
            .args_json(json!({"receiver_id": to, "amount": (200 * ONE).to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }
    let (req0, agent0) = (balance(&c, &requester).await?, balance(&c, &agent).await?);
    assert_eq!(supply(&c).await?, supply0);

    // Requester pays the fee into escrow.
    let id: u32 = call(&requester, &c, "request_forecast", json!({"market_id": slug}))
        .await?
        .json()?;
    assert_eq!(balance(&c, &requester).await?, req0 - fee, "fee escrowed");

    // The real keeper reads the real market; its output goes in as is.
    let market = keeper_post(id, &slug)?;
    let n = market["outcomes"].as_array().unwrap().len();
    println!("keeper read {slug}: {n} outcomes, odds {}", market["odds"]);
    let _ = call(&keeper, &c, "post_request_odds", json!({"request_id": id, "market": market.clone()})).await?;
    let r: Value = call(&cranker, &c, "finalize_request_odds", json!({"request_id": id}))
        .await?
        .json()?;
    let colony = r["colony"].as_u64().unwrap();
    assert_eq!(r["market"]["odds"], market["odds"], "contract stores what the keeper posted");

    // One forecaster agent posts a lean towards the first outcome.
    let mut mine = vec![4000 / (n as u16 - 1); n];
    mine[0] = 6000;
    mine[1] += 10_000 - mine.iter().sum::<u16>();
    let _ = call(&agent, &c, "register_agent", json!({})).await?;
    assert_eq!(balance(&c, &agent).await?, agent0 - deposit, "deposit locked");
    let _ = call(&agent, &c, "post_forecast", json!({"colony": colony, "odds": mine})).await?;

    // The first crank must carry the drand round the request committed to.
    let sig = common::beacon(r["drand_round"].as_u64().ok_or("no drand round")?);
    let mut done = None;
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
        let v: Value = r.json()?;
        if v["phase"] == "done" {
            done = Some(v);
            break;
        }
    }
    let v = done.ok_or("request never finished")?;

    // The market hash is the native one, so any browser can verify it.
    let odds: Vec<u16> = serde_json::from_value(v["market"]["odds"].clone())?;
    let odds_6h: Vec<u16> = serde_json::from_value(v["market"]["odds_6h"].clone())?;
    let agent_odds: Vec<u16> = serde_json::from_value(v["agents"]["odds"].clone())?;
    let weights: Vec<u32> = serde_json::from_value(v["stakes"]["weights"].clone())?;
    assert_eq!(weights, vec![0; n], "nobody staked");
    let native = forecast_market(
        &hex32(v["seed"].as_str().unwrap()),
        colony as u16,
        &odds,
        &odds_6h,
        &weights,
        hex32(v["stakes"]["hash"].as_str().unwrap()),
        &agent_odds,
        hex32(v["agents"]["hash"].as_str().unwrap()),
        FORECAST_ANTS,
        FORECAST_TICKS,
    )
    .map_err(|e| format!("{e:?}"))?;
    assert_eq!(v["market_hash"].as_str().unwrap(), native.hash_hex());

    // Token side: 20% to the keeper, 30% to the lone agent, 10% to the
    // crankers (no bounty here), the rest burned; the deposit comes back on
    // unregister.
    let keeper_got = balance(&c, &keeper).await?;
    let agent_net = balance(&c, &agent).await? as i128 - agent0 as i128;
    let burned = supply0 - supply(&c).await?;
    println!(
        "keeper +{} agent net {:+} burned {} (whole tokens, deposit still held)",
        keeper_got / ONE,
        agent_net / ONE as i128,
        burned / ONE
    );
    assert_eq!(keeper_got, fee * 2000 / 10_000);
    assert_eq!(agent_net, (fee * 3000 / 10_000) as i128 - deposit as i128, "payout, deposit still held");
    let _ = call(&agent, &c, "unregister_agent", json!({})).await?;
    assert_eq!(
        balance(&c, &agent).await? as i128 - agent0 as i128,
        (fee * 3000 / 10_000) as i128,
        "deposit refunded on unregister"
    );
    assert_eq!(burned, fee - fee * (2000 + 3000 + 1000) / 10_000);
    assert_eq!(balance(&c, &requester).await?, req0 - fee, "requester pays once");
    println!("swarm {:?}, hash {}", v["swarm"], v["market_hash"]);
    Ok(())
}
