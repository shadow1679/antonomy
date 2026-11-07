//! Real gas per call, from a local NEAR sandbox (no testnet account needed;
//! near-workspaces downloads the sandbox binary on first run). Build the wasm
//! first, then print the table with --nocapture:
//!
//!   cargo near build non-reproducible-wasm --manifest-path sim/gasbench/Cargo.toml
//!   cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml -- --nocapture
//!
//! Also checks that the colony run in wasm ends on the native result hash.

use antosim::{run, seed_from_int, BURN_TICKS, N_ANTS};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Contract;
use serde_json::json;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/antosim_gasbench.wasm");
const TGAS: f64 = 1e12;
const LIMIT_TGAS: f64 = 300.0;

/// Gas burnt by the function call itself (the receipt the 300 TGas limit applies to).
fn call_gas(r: &ExecutionFinalResult) -> f64 {
    r.receipt_outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap_or(0) as f64
        / TGAS
}

async fn call(c: &Contract, method: &str, args: serde_json::Value) -> Res<ExecutionFinalResult> {
    let r = c.call(method).args_json(args).max_gas().transact().await?;
    if r.is_failure() {
        return Err(format!("{method} failed: {:?}", r.failures()).into());
    }
    Ok(r)
}

/// Run one colony in chunks; print gas per chunk; return (fixed cost, max per tick).
async fn colony(c: &Contract, seed: u64, n: u8, ants: u16, ticks: u16, chunk: u32) -> Res<(f64, f64)> {
    println!("\n{n} options, {ants} ants, {ticks} ticks, {chunk} ticks per call");
    let start = call(c, "start", json!({"seed": seed, "n": n, "ants": ants, "ticks": ticks})).await?;
    let fixed = call_gas(&call(c, "advance", json!({"steps": 0})).await?);
    println!("  start       {:7.2} TGas", call_gas(&start));
    println!("  advance(0)  {fixed:7.2} TGas  (load + store, no ticks)");
    let mut worst = 0f64;
    let mut sum = 0f64;
    let mut t = 0;
    while t < ticks as u32 {
        let r = call(c, "advance", json!({"steps": chunk})).await?;
        let g = call_gas(&r);
        let to: u32 = r.json()?;
        let per_tick = (g - fixed) / (to - t) as f64;
        worst = worst.max(per_tick);
        sum += g;
        println!("  ticks {:>3}..{:<3} {g:7.2} TGas  {per_tick:.3} TGas/tick", t + 1, to);
        t = to;
    }
    let calls = (ticks as u32).div_ceil(chunk);
    println!("  whole run   {sum:7.2} TGas over {calls} calls");
    let hash: String = c.view("result").await?.json()?;
    let native = run(&seed_from_int(seed), n as usize, None, ants as usize, ticks as u32)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(hash, native.hash_hex(), "wasm and native results differ");
    println!("  result hash matches the native run");
    Ok((fixed, worst))
}

#[tokio::test]
async fn gas_per_tick() -> Res<()> {
    let wasm = std::fs::read(WASM).map_err(|e| {
        format!("{WASM}: {e}. Build it with: cargo near build non-reproducible-wasm --manifest-path sim/gasbench/Cargo.toml")
    })?;
    println!("wasm size {} bytes", wasm.len());
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm).await?;

    let (fixed, worst) = colony(&c, 0, 5, 150, 800, 50).await?;
    let fit = ((LIMIT_TGAS - fixed) / worst) as u32;
    println!("  at the worst tick rate, one 300 TGas call fits about {fit} ticks");
    let (ffixed, fworst) = colony(&c, 0, 3, 60, 300, 50).await?;
    let ffit = ((LIMIT_TGAS - ffixed) / fworst) as u32;
    println!("  at the worst tick rate, one 300 TGas call fits about {ffit} ticks");

    // Whole runs in one call where the estimate says they fit.
    for (n, ants, ticks) in [(5u8, 150u16, 800u16), (3, 60, 300)] {
        let _ = call(&c, "start", json!({"seed": 1, "n": n, "ants": ants, "ticks": ticks})).await?;
        let r = c
            .call("advance")
            .args_json(json!({"steps": ticks}))
            .max_gas()
            .transact()
            .await?;
        if r.is_success() {
            println!("\n{ants} ants x {ticks} ticks in one call: {:.2} TGas", call_gas(&r));
        } else {
            println!("\n{ants} ants x {ticks} ticks in one call: does not fit in {LIMIT_TGAS} TGas");
        }
    }

    // sha256 in wasm against the host function, 100 hashes of 128 bytes each.
    println!();
    let base = call_gas(&call(&c, "hash_in_wasm", json!({"reps": 0, "len": 128})).await?);
    for m in ["hash_in_wasm", "hash_host"] {
        let g = call_gas(&call(&c, m, json!({"reps": 100, "len": 128})).await?);
        println!("{m:<13} {:.4} TGas per 128-byte hash", (g - base) / 100.0);
    }
    Ok(())
}

/// The Burn colony's daily run (150 ants, BURN_TICKS) in calls of 2,000 ticks.
/// About 22 calls; run it on its own:
///   cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn burn_day() -> Res<()> {
    const CHUNK: u32 = 2000;
    let wasm = std::fs::read(WASM)?;
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm).await?;
    let _ = call(&c, "start", json!({"seed": 0, "n": 5, "ants": N_ANTS, "ticks": BURN_TICKS})).await?;
    let (mut t, mut sum, mut worst, mut calls) = (0u32, 0f64, 0f64, 0u32);
    while t < BURN_TICKS {
        let r = call(&c, "advance", json!({"steps": CHUNK})).await?;
        let g = call_gas(&r);
        t = r.json()?;
        sum += g;
        worst = worst.max(g);
        calls += 1;
    }
    println!("\nburn day: {BURN_TICKS} ticks, 150 ants, {calls} calls of {CHUNK} ticks");
    println!("  total {sum:.1} TGas, worst call {worst:.2} TGas, {:.4} TGas per tick", sum / BURN_TICKS as f64);
    let hash: String = c.view("result").await?.json()?;
    let native = run(&seed_from_int(0), 5, None, N_ANTS, BURN_TICKS).map_err(|e| format!("{e:?}"))?;
    assert_eq!(hash, native.hash_hex(), "wasm and native results differ");
    println!("  result hash matches the native run");
    Ok(())
}
