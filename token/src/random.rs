//! Randomness as a service: other contracts (or people) request a value and
//! read it once the drand round their request committed to has been proven
//! on-chain. The output is a full 32-byte hash, not a colony's winner (a
//! winner among five options carries about two bits).
//!
//! A request made at time `t` commits to drand round `round_after(t) + 1`:
//! the first round published after `t`, plus one for clock skew, so a
//! requester can't have seen the beacon when asking. Anyone proves the round
//! once (`fulfill_randomness`, a drand BLS signature the contract checks), and
//! every request on that round gets its own value:
//!
//! `value = sha256(TAG, randomness, request id u64, requester, contract)`
//!
//! with a length-prefixed (u16) requester and contract account, all
//! big-endian. The contract keeps the pending/ready state under its own
//! storage keys, so none of it touches the contract's main state.

use antosim::sha256;

pub const TAG: &[u8] = b"ANTO-RAND-v1";

/// The value request `id` gets from `randomness`, drand's randomness for the
/// round it committed to (sha256 of that round's signature).
pub fn value(randomness: &[u8; 32], id: u64, requester: &str, contract: &str) -> [u8; 32] {
    let mut buf = TAG.to_vec();
    buf.extend_from_slice(randomness);
    buf.extend_from_slice(&id.to_be_bytes());
    for account in [requester, contract] {
        buf.extend_from_slice(&(account.len() as u16).to_be_bytes());
        buf.extend_from_slice(account.as_bytes());
    }
    sha256(&buf)
}

/// A request waiting for, or holding, its value.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct RandomRequest {
    pub requester: String,
    /// The drand round the value is drawn from.
    pub round: u64,
    pub at_ms: u64,
}

/// A value reduced to an index below `n` (a draw among `n` things): the hash
/// read as a big-endian integer, mod `n`. The bias is under n / 2^256.
pub fn pick(value: &[u8; 32], n: u32) -> u32 {
    assert!(n > 0, "pick needs n > 0");
    let n = u64::from(n);
    let mut r = 0u64;
    for byte in value {
        r = ((r << 8) | u64::from(*byte)) % n;
    }
    r as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: [u8; 32] = [7; 32];

    #[test]
    fn value_depends_on_every_input() {
        let v = value(&R, 0, "alice.testnet", "oracle.testnet");
        assert_eq!(v, value(&R, 0, "alice.testnet", "oracle.testnet"));
        assert_ne!(v, value(&[8; 32], 0, "alice.testnet", "oracle.testnet"));
        assert_ne!(v, value(&R, 1, "alice.testnet", "oracle.testnet"));
        assert_ne!(v, value(&R, 0, "bob.testnet", "oracle.testnet"));
        assert_ne!(v, value(&R, 0, "alice.testnet", "other.testnet"));
    }

    #[test]
    fn accounts_are_length_prefixed() {
        // Moving a character between the two accounts must change the hash.
        assert_ne!(value(&R, 0, "ab", "c"), value(&R, 0, "a", "bc"));
    }

    #[test]
    fn value_matches_the_spec_layout() {
        let mut buf = b"ANTO-RAND-v1".to_vec();
        buf.extend_from_slice(&R);
        buf.extend_from_slice(&5u64.to_be_bytes());
        buf.extend_from_slice(&[0, 1, b'a', 0, 1, b'c']);
        assert_eq!(value(&R, 5, "a", "c"), sha256(&buf));
    }

    /// Vectors made with Python's hashlib from the spec, and read by
    /// `web/test_random.mjs`. The randomness is quicknet round 1's.
    #[test]
    fn value_matches_the_cross_language_vectors() {
        let r1: [u8; 32] = [
            0x14, 0x66, 0xa6, 0xcd, 0x24, 0xe3, 0x27, 0x18, 0x87, 0x70, 0x75, 0x2f, 0x61, 0x34, 0x00,
            0x1c, 0x64, 0xd6, 0xef, 0xcc, 0x59, 0x0c, 0xcc, 0x26, 0xb7, 0x21, 0x61, 0x1a, 0xd9, 0x6f,
            0x16, 0x5a,
        ];
        let hex = |v: [u8; 32]| antosim::to_hex(&v);
        assert_eq!(
            hex(value(&r1, 0, "alice.testnet", "antonomy-oracle.testnet")),
            "5de4e3a2ea9b1f2f5c418f4505c40becb903c8dd059db6892520fbfa0dde9064"
        );
        assert_eq!(
            hex(value(&r1, 7, "consumer.testnet", "antonomy-oracle.testnet")),
            "db7d1402453fbcab7f4ec38323f08122caf0263ccfd23c0848568c241a56fc2f"
        );
    }

    #[test]
    fn pick_is_the_big_endian_value_mod_n() {
        let mut v = [0u8; 32];
        v[31] = 10;
        assert_eq!(pick(&v, 3), 1);
        assert_eq!(pick(&v, 1), 0);
        v[30] = 1; // 256 + 10 = 266
        assert_eq!(pick(&v, 7), 266 % 7);
        // A high byte counts too: 2^248 mod 5 = 1 (2^4 = 16 = 1 mod 5).
        let mut h = [0u8; 32];
        h[0] = 1;
        assert_eq!(pick(&h, 5), 1);
    }

    #[test]
    fn pick_covers_every_index() {
        let mut seen = [false; 5];
        for id in 0..200 {
            seen[pick(&value(&R, id, "a", "c"), 5) as usize] = true;
        }
        assert!(seen.iter().all(|s| *s));
    }
}
