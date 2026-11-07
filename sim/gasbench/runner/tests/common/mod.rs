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
