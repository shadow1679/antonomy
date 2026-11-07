//! drand quicknet beacons for the sandbox tests. The sandbox runs on the real
//! clock, so a seed commits to a real quicknet round; this fetches its
//! signature with curl, waiting for it to be published if need be.

use std::process::Command;
use std::time::Duration;

const CHAIN: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/// The hex signature of quicknet round `round`.
pub fn beacon(round: u64) -> String {
    let url = format!("https://api.drand.sh/{CHAIN}/public/{round}");
    for _ in 0..180 {
        let out = Command::new("curl")
            .args(["-sf", "--max-time", "10", &url])
            .output()
            .expect("curl");
        if out.status.success() {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                if let Some(s) = v["signature"].as_str() {
                    return s.to_string();
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    panic!("drand round {round} was not published within three minutes");
}

/// `commit_forecast`'s hash, hex (token/src/agents.rs `commit_hash`).
#[allow(dead_code)]
pub fn commit_hash(colony: u16, odds: &[u16], salt: &[u8; 32], who: &str) -> String {
    let mut buf = b"ANTO-COMMIT-v0".to_vec();
    buf.extend_from_slice(&colony.to_be_bytes());
    buf.push(odds.len() as u8);
    for o in odds {
        buf.extend_from_slice(&o.to_be_bytes());
    }
    buf.extend_from_slice(salt);
    buf.extend_from_slice(who.as_bytes());
    hex(&antosim::sha256(&buf))
}

#[allow(dead_code)]
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// An agent's forecast, the way the contract takes it: commit now, wait
/// (moving the sandbox on) for the window's reveal phase, then reveal.
#[allow(dead_code)]
pub async fn forecast(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    c: &near_workspaces::Contract,
    agent: &near_workspaces::Account,
    colony: u64,
    odds: &[u16],
) -> Result<(), Box<dyn std::error::Error>> {
    let salt = antosim::sha256(agent.id().as_bytes());
    let hash = commit_hash(colony as u16, odds, &salt, agent.id().as_str());
    let r = agent
        .call(c.id(), "commit_forecast")
        .args_json(serde_json::json!({"colony": colony, "hash": hash}))
        .max_gas()
        .transact()
        .await?;
    if r.is_failure() {
        return Err(format!("commit_forecast failed: {:?}", r.failures()).into());
    }
    for _ in 0..120 {
        let w: serde_json::Value = c
            .view("agent_window")
            .args_json(serde_json::json!({"colony": colony}))
            .await?
            .json()?;
        if w["phase"] == "reveal" {
            break;
        }
        worker.fast_forward(1).await?;
    }
    let r = agent
        .call(c.id(), "reveal_forecast")
        .args_json(serde_json::json!({"colony": colony, "odds": odds, "salt": hex(&salt)}))
        .max_gas()
        .transact()
        .await?;
    if r.is_failure() {
        return Err(format!("reveal_forecast failed: {:?}", r.failures()).into());
    }
    Ok(())
}
