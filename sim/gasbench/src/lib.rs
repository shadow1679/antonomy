//! Gas bench for the colony on NEAR. Stores one `antosim::Colony` as raw bytes
//! (`Colony::to_bytes`) and advances it a few ticks per call, the way the
//! product contract will, so `tests/gas.rs` can read real gas per call from a
//! local sandbox. Testnet and sandbox only; not the product contract.
//!
//! It also stands in for a NEP-141 receiver (`ft_on_transfer`) in the product
//! contract's `ft_transfer_call` sandbox test (`runner/tests/ft.rs`).

use antosim::{seed_from_int, sha256, Colony};
use near_sdk::json_types::U128;
use near_sdk::{env, ext_contract, near, AccountId, Gas, Promise};

const KEY: &[u8] = b"colony";
const DRAW_ID_KEY: &[u8] = b"draw-id";
const DRAW_VALUE_KEY: &[u8] = b"draw-value";

/// The oracle's randomness service, as a consumer sees it.
#[ext_contract(ext_oracle)]
pub trait Oracle {
    fn request_randomness(&mut self) -> u64;
    fn randomness_value(&self, id: u64) -> Option<String>;
}

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

    /// Stand-in NEP-141 receiver: keeps `keep:<yocto>` of the transfer (all
    /// of it with any other `msg`) and reports the rest unused. `panic` fails.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        env::log_str(&format!("received {} from {sender_id}: {msg}", amount.0));
        if msg == "panic" {
            env::panic_str("receiver refused");
        }
        let keep = msg
            .strip_prefix("keep:")
            .and_then(|k| k.parse::<u128>().ok())
            .unwrap_or(amount.0)
            .min(amount.0);
        U128(amount.0 - keep)
    }

    // ---- a demo consumer of the oracle's randomness service ----
    // (`runner/tests/random.rs`). The bench account holds the $ANTO for the
    // fee, asks with `draw`, and reads the value back with `collect`.

    /// Ask `oracle` for a random value; the id is kept by `on_drawn`.
    pub fn draw(&mut self, oracle: AccountId) -> Promise {
        ext_oracle::ext(oracle)
            .with_static_gas(Gas::from_tgas(10))
            .request_randomness()
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).on_drawn())
    }

    #[private]
    pub fn on_drawn(&mut self, #[callback_result] id: Result<u64, near_sdk::PromiseError>) -> u64 {
        let id = id.unwrap_or_else(|_| env::panic_str("request_randomness failed"));
        env::storage_write(DRAW_ID_KEY, &id.to_be_bytes());
        env::storage_remove(DRAW_VALUE_KEY);
        id
    }

    /// Read the value of the request `draw` made; null while it is pending.
    pub fn collect(&mut self, oracle: AccountId) -> Promise {
        let id = self.drawn().0.unwrap_or_else(|| env::panic_str("draw first"));
        ext_oracle::ext(oracle)
            .with_static_gas(Gas::from_tgas(5))
            .randomness_value(id)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).on_collected())
    }

    #[private]
    pub fn on_collected(
        &mut self,
        #[callback_result] value: Result<Option<String>, near_sdk::PromiseError>,
    ) -> Option<String> {
        let value = value.unwrap_or_else(|_| env::panic_str("randomness_value failed"));
        if let Some(v) = &value {
            env::storage_write(DRAW_VALUE_KEY, v.as_bytes());
        }
        value
    }

    /// The consumer's request id and the value it collected so far.
    pub fn drawn(&self) -> (Option<u64>, Option<String>) {
        let id = env::storage_read(DRAW_ID_KEY)
            .and_then(|b| <[u8; 8]>::try_from(b).ok())
            .map(u64::from_be_bytes);
        let value = env::storage_read(DRAW_VALUE_KEY).and_then(|b| String::from_utf8(b).ok());
        (id, value)
    }
}
