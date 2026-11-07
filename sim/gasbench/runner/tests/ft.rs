//! NEP-141 `ft_transfer_call` and NEP-145 storage management on the product
//! contract in a local NEAR sandbox, with the gasbench contract as a receiver
//! (`keep:<yocto>` keeps that much and reports the rest unused). Build both
//! wasms first:
//!
//!   cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
//!   cargo near build non-reproducible-wasm --manifest-path sim/gasbench/Cargo.toml
//!   cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml --test ft -- --nocapture

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const PRODUCT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../contract/target/near/antonomy_contract.wasm"
);
const RECEIVER: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/antosim_gasbench.wasm"
);
const ONE: u128 = 1_000_000_000_000_000_000_000_000;

fn read(path: &str) -> Res<Vec<u8>> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}. Build it with cargo near build (see the top of this file)").into())
}

async fn balance(c: &Contract, who: &str) -> Res<u128> {
    let v: String = c.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

async fn transfer_call(from: &Account, c: &Contract, to: &str, amount: u128, msg: &str) -> Res<ExecutionFinalResult> {
    Ok(from
        .call(c.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": to, "amount": amount.to_string(), "msg": msg}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?)
}

fn used(r: &ExecutionFinalResult) -> Res<u128> {
    let v: String = r.clone().into_result()?.json()?;
    Ok(v.parse()?)
}

#[tokio::test]
async fn transfer_call_and_storage() -> Res<()> {
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&read(PRODUCT)?).await?;
    let dex = worker.dev_deploy(&read(RECEIVER)?).await?;
    let treasury = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let plain = worker.dev_create_account().await?;
    c.call("new")
        .args_json(json!({
            "treasury": treasury.id(), "guardian": treasury.id(),
            "total_supply": (1_000_000 * ONE).to_string(), "cap_per_wallet": (100 * ONE).to_string(),
            "close_at_ms": 0u64, "publish_at_ms": 1u64,
            "keepers": [treasury.id()], "quorum": 1,
            "request_config": {
                "fee": (100 * ONE).to_string(), "keeper_bps": 2000, "agent_bps": 3000, "crank_bps": 1000,
                "odds_window_ms": 600_000u64, "forecast_window_ms": 60_000u64,
                "agent_deposit": (10 * ONE).to_string(), "crank_bounty": "0"
            },
            "round_config": {"stake_ms": 60_000u64, "gap_ms": 10_000u64},
            "faucet_amount": (100 * ONE).to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let a = alice.id().as_str();

    // Storage: a wallet checks registration, deposits, and gets it all back.
    let b: Value = c.view("storage_balance_of").args_json(json!({"account_id": a})).await?.json()?;
    assert_eq!(b, json!({"total": "0", "available": "0"}));
    let before = alice.view_account().await?.balance;
    let r = alice
        .call(c.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(125))
        .transact()
        .await?
        .into_result()?;
    let after = alice.view_account().await?.balance;
    let spent = before.as_yoctonear() - after.as_yoctonear();
    assert!(spent < NearToken::from_millinear(5).as_yoctonear(), "deposit refunded, only gas spent ({spent})");
    println!("storage_deposit refunded; {} receipts", r.receipt_outcomes().len());

    let _ = alice.call(c.id(), "claim_play_tokens").transact().await?.into_result()?;
    assert_eq!(balance(&c, a).await?, 100 * ONE);

    // The receiver keeps 30 of 50 and returns 20.
    let r = transfer_call(&alice, &c, dex.id().as_str(), 50 * ONE, &format!("keep:{}", 30 * ONE)).await?;
    assert_eq!(used(&r)?, 30 * ONE);
    assert_eq!(balance(&c, dex.id().as_str()).await?, 30 * ONE);
    assert_eq!(balance(&c, a).await?, 70 * ONE);
    let worst = r.receipt_outcomes().iter().map(|o| o.gas_burnt.as_gas()).max().unwrap_or(0) as f64 / 1e12;
    println!("ft_transfer_call keep 30 of 50: used 30, worst receipt {worst:.2} TGas");

    // A receiver that panics, and an account with no contract: full refund.
    let r = transfer_call(&alice, &c, dex.id().as_str(), 10 * ONE, "panic").await?;
    assert_eq!(used(&r)?, 0);
    let r = transfer_call(&alice, &c, plain.id().as_str(), 10 * ONE, "").await?;
    assert_eq!(used(&r)?, 0);
    assert_eq!(balance(&c, a).await?, 70 * ONE);
    assert_eq!(balance(&c, plain.id().as_str()).await?, 0);
    println!("panicking receiver and plain account: refunded in full");

    // Unregister: refused with a balance, burns it with force.
    let supply: String = c.view("ft_total_supply").await?.json()?;
    let r = alice
        .call(c.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(r.is_failure(), "has a balance");
    let gone: bool = alice
        .call(c.id(), "storage_unregister")
        .args_json(json!({"force": true}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(gone);
    let supply2: String = c.view("ft_total_supply").await?.json()?;
    assert_eq!(supply.parse::<u128>()? - supply2.parse::<u128>()?, 70 * ONE);
    println!("storage_unregister with force burned 70");
    Ok(())
}
