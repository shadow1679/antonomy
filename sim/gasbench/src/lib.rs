//! Gas bench for the colony on NEAR. Stores one `antosim::Colony` as raw bytes
//! (`Colony::to_bytes`) and advances it a few ticks per call, the way the
//! product contract will, so `tests/gas.rs` can read real gas per call from a
//! local sandbox. Testnet and sandbox only; not the product contract.

use antosim::{seed_from_int, sha256, Colony};
use near_sdk::{env, near};

const KEY: &[u8] = b"colony";

#[near(contract_state)]
#[derive(Default)]
pub struct Bench {}

fn load() -> Colony {
    let b = env::storage_read(KEY).unwrap_or_else(|| env::panic_str("no colony"));
    Colony::from_bytes(&b).unwrap_or_else(|_| env::panic_str("bad colony state"))
}

fn save(c: &Colony) {
    env::storage_write(KEY, &c.to_bytes());
}

#[near]
impl Bench {
    /// Start a colony from `seed_from_int(seed)` with no supplied richness.
    pub fn start(&mut self, seed: u64, n: u8, ants: u16, ticks: u32) {
        let c = Colony::new(&seed_from_int(seed), n as usize, None, ants as usize, ticks)
            .unwrap_or_else(|e| env::panic_str(&format!("{e:?}")));
        save(&c);
    }

    /// Load the colony, run up to `steps` ticks, store it. Returns the tick reached.
    /// `steps = 0` measures the fixed cost of loading and storing.
    pub fn advance(&mut self, steps: u32) -> u32 {
        let mut c = load();
        for _ in 0..steps {
            if !c.step() {
                break;
            }
        }
        save(&c);
        c.t
    }

    /// Result hash, hex. Panics before the final tick.
    pub fn result(&self) -> String {
        let r = load().result().unwrap_or_else(|e| env::panic_str(&format!("{e:?}")));
        r.hash_hex()
    }

    /// `reps` sha256 hashes of `len` bytes with the sim crate's own sha256.
    pub fn hash_in_wasm(&self, reps: u32, len: u32) -> String {
        let mut h = vec![7u8; len.max(32) as usize];
        for _ in 0..reps {
            let d = sha256(&h);
            h[..32].copy_from_slice(&d);
        }
        antosim::to_hex(&h[..32])
    }

    /// The same with the host's `env::sha256`.
    pub fn hash_host(&self, reps: u32, len: u32) -> String {
        let mut h = vec![7u8; len.max(32) as usize];
        for _ in 0..reps {
            let d = env::sha256_array(&h);
            h[..32].copy_from_slice(&d);
        }
        antosim::to_hex(&h[..32])
    }
}
