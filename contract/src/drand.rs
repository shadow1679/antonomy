//! drand quicknet beacons, checked on-chain with NEAR's BLS12-381 host
//! functions.
//!
//! Every seed commits to a drand round fixed by time: the first quicknet round
//! published after the run's inputs close (`round_after`). The call that draws
//! the seed must carry that round's signature. The contract checks it against
//! quicknet's public key (scheme `bls-unchained-g1-rfc9380`: the signature is
//! on G1, the key on G2, the message is sha256 of the round number as 8
//! big-endian bytes) and takes sha256(signature), which is drand's published
//! randomness, as the entropy. The caller can't pick the round or forge the
//! signature, so neither the caller nor a validator can steer the seed. The
//! cost is liveness: no beacon, no seed.
//!
//! near-sdk's `env::bls12381_*` wrappers ignore the host's error code and read
//! the register anyway, so a rejected input would hand back the previous
//! call's output. This module calls `near_sys` directly and checks the code.

use near_sdk::env;

// Quicknet, chain hash 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971:
// https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info
pub const GENESIS_MS: u64 = 1_692_803_367_000;
pub const PERIOD_MS: u64 = 3_000;
/// Quicknet's group public key, compressed G2.
const PUBLIC_KEY: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
/// The G2 generator, compressed.
const G2: &str = "93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8";
const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
/// The BLS12-381 base field modulus, little-endian 64-bit limbs.
const P: [u64; 6] = [
    0xb9fe_ffff_ffff_aaab,
    0x1eab_fffe_b153_ffff,
    0x6730_d2a0_f6b0_f624,
    0x6477_4b84_f385_12bf,
    0x4b1b_a7b6_434b_acd7,
    0x1a01_11ea_397f_e69a,
];

/// The first quicknet round published strictly after `ms`. Times before
/// quicknet's genesis give round 1; only unit tests use them.
pub fn round_after(ms: u64) -> u64 {
    match ms.checked_sub(GENESIS_MS) {
        Some(d) => d / PERIOD_MS + 2,
        None => 1,
    }
}

/// The entropy of a seed committed to `round`: that beacon's randomness.
/// Panics unless `signature` (hex) is drand's signature of `round`.
pub fn entropy(round: u64, signature: Option<&str>) -> [u8; 32] {
    let sig = signature
        .unwrap_or_else(|| env::panic_str(&format!("drand round {round}: signature needed")));
    let sig = unhex(sig)
        .filter(|b| b.len() == 48)
        .unwrap_or_else(|| env::panic_str("drand signature: 48 bytes of hex expected"));
    verify(round, &sig)
        .unwrap_or_else(|| env::panic_str(&format!("not drand round {round}'s signature")))
}

/// drand's randomness for `round` if `sig` is quicknet's signature of it.
pub fn verify(round: u64, sig: &[u8]) -> Option<[u8; 32]> {
    use near_sys as sys;
    if sig.len() != 48 {
        return None;
    }
    // H(m) = map(u0) + map(u1); the host map clears the cofactor, which is
    // linear, so the sum is RFC 9380's hash_to_curve.
    let u = expand_message(&env::sha256_array(round.to_be_bytes()));
    let mut fp = mod_p(&u[..64]).to_vec();
    fp.extend_from_slice(&mod_p(&u[64..]));
    let q = bls(sys::bls12381_map_fp_to_g1, &fp)?;
    let mut sum = vec![0u8];
    sum.extend_from_slice(&q[..96]);
    sum.push(0);
    sum.extend_from_slice(&q[96..]);
    let h = bls(sys::bls12381_p1_sum, &sum)?;
    // e(-sig, g2) * e(H(m), pk) == 1.
    let mut neg = vec![1u8];
    neg.extend_from_slice(&bls(sys::bls12381_p1_decompress, sig)?);
    let mut pairs = bls(sys::bls12381_p1_sum, &neg)?;
    pairs.extend_from_slice(&bls(sys::bls12381_p2_decompress, &unhex(G2)?)?);
    pairs.extend_from_slice(&h);
    pairs.extend_from_slice(&bls(sys::bls12381_p2_decompress, &unhex(PUBLIC_KEY)?)?);
    let rc = unsafe { sys::bls12381_pairing_check(pairs.len() as u64, pairs.as_ptr() as u64) };
    (rc == 0).then(|| env::sha256_array(sig))
}

/// One BLS12-381 host call into this module's own register; None when the
/// host rejects the input.
fn bls(f: unsafe extern "C" fn(u64, u64, u64) -> u64, input: &[u8]) -> Option<Vec<u8>> {
    const REGISTER: u64 = 0xd7a4d;
    let rc = unsafe { f(input.len() as u64, input.as_ptr() as u64, REGISTER) };
    if rc != 0 {
        return None;
    }
    env::read_register(REGISTER)
}

/// RFC 9380 expand_message_xmd with SHA-256, 128 bytes: two field elements
/// of 64 bytes each.
fn expand_message(msg: &[u8]) -> Vec<u8> {
    let mut dst = DST.to_vec();
    dst.push(DST.len() as u8);
    let mut m = vec![0u8; 64];
    m.extend_from_slice(msg);
    m.extend_from_slice(&[0, 128, 0]);
    m.extend_from_slice(&dst);
    let b0 = env::sha256_array(&m);
    let mut out = Vec::with_capacity(128);
    let mut prev = [0u8; 32];
    for i in 1..=4u8 {
        let mut m: Vec<u8> = b0.iter().zip(prev).map(|(a, b)| a ^ b).collect();
        m.push(i);
        m.extend_from_slice(&dst);
        prev = env::sha256_array(&m);
        out.extend_from_slice(&prev);
    }
    out
}

/// A big-endian integer mod p, as 48 big-endian bytes. Bit by bit: the
/// running value stays below 2p < 2^382, so six limbs hold it.
fn mod_p(bytes: &[u8]) -> [u8; 48] {
    let mut r = [0u64; 6];
    for byte in bytes {
        for k in (0..8).rev() {
            let mut carry = u64::from((byte >> k) & 1);
            for limb in r.iter_mut() {
                let top = *limb >> 63;
                *limb = (*limb << 1) | carry;
                carry = top;
            }
            if !below_p(&r) {
                let mut borrow = false;
                for (limb, p) in r.iter_mut().zip(P) {
                    let (d, b1) = limb.overflowing_sub(p);
                    let (d, b2) = d.overflowing_sub(u64::from(borrow));
                    *limb = d;
                    borrow = b1 || b2;
                }
            }
        }
    }
    let mut out = [0u8; 48];
    for (i, limb) in r.iter().enumerate() {
        out[40 - 8 * i..48 - 8 * i].copy_from_slice(&limb.to_be_bytes());
    }
    out
}

fn below_p(r: &[u64; 6]) -> bool {
    for i in (0..6).rev() {
        if r[i] != P[i] {
            return r[i] < P[i];
        }
    }
    false
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// Real quicknet beacons: (round, signature, randomness).
    pub const BEACONS: [(u64, &str, &str); 3] = [
        (1, "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b", "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a"),
        (2, "b6b6a585449b66eb12e875b64fcbab3799861a00e4dbf092d99e969a5eac57dd3f798acf61e705fe4f093db926626807", "5782d6987841c654515a0e72b2d1ebb4e741234042c37cb19608ae50d93fb60c"),
        (33_455_254, "84b8909faad71eaf097f23ec5b908736e0e1ae471025b92ed1f088c7166b6c3f004d43f68d288ec4552d2b8cab289d62", "f76351b59460aa3bd8d175c86aef9cd0e69052623d50c9280e4f09231116069a"),
    ];
    /// Round 1's signature: every pre-genesis block time in the contract's
    /// unit tests commits to round 1.
    pub const ROUND_1_SIG: &str = BEACONS[0].1;

    /// When `round` is published, in milliseconds.
    fn published_at(round: u64) -> u64 {
        GENESIS_MS + (round - 1) * PERIOD_MS
    }

    #[test]
    fn real_beacons_verify_and_give_drands_randomness() {
        testing_env!(VMContextBuilder::new().build());
        for (round, sig, randomness) in BEACONS {
            let g0 = env::used_gas().as_gas();
            assert_eq!(entropy(round, Some(sig)).to_vec(), unhex(randomness).unwrap());
            let g = env::used_gas().as_gas() - g0;
            assert!(g < 10_000_000_000_000, "{g} gas");
        }
    }

    #[test]
    fn wrong_round_or_tampered_signature_fails() {
        testing_env!(VMContextBuilder::new().build());
        let (round, sig, _) = BEACONS[2];
        let sig = unhex(sig).unwrap();
        assert_eq!(verify(round + 1, &sig), None);
        assert_eq!(verify(round - 1, &sig), None);
        let mut bad = sig.clone();
        bad[47] ^= 1;
        assert_eq!(verify(round, &bad), None);
        assert_eq!(verify(round, &sig[..47]), None);
        // Round 2's signature is a valid point, but not round 1's.
        assert_eq!(verify(1, &unhex(BEACONS[1].1).unwrap()), None);
    }

    #[test]
    #[should_panic(expected = "signature needed")]
    fn missing_signature_panics() {
        testing_env!(VMContextBuilder::new().build());
        entropy(5, None);
    }

    #[test]
    #[should_panic(expected = "48 bytes of hex")]
    fn malformed_signature_panics() {
        testing_env!(VMContextBuilder::new().build());
        entropy(5, Some("zz"));
    }

    #[test]
    fn rounds_follow_the_clock() {
        assert_eq!(published_at(1), GENESIS_MS);
        assert_eq!(round_after(0), 1);
        assert_eq!(round_after(GENESIS_MS - 1), 1);
        // Strictly after: the round published at `ms` itself doesn't count.
        assert_eq!(round_after(GENESIS_MS), 2);
        assert_eq!(round_after(GENESIS_MS + PERIOD_MS - 1), 2);
        assert_eq!(round_after(GENESIS_MS + PERIOD_MS), 3);
        for ms in [GENESIS_MS, GENESIS_MS + 1, 1_793_000_000_000, 1_793_000_000_001] {
            let r = round_after(ms);
            assert!(published_at(r) > ms && published_at(r - 1) <= ms);
        }
    }

    #[test]
    fn mod_p_reduces() {
        assert!(below_p(&limbs(&mod_p(&[0xff; 64]))));
        // p itself reduces to 0, p + 5 to 5.
        let mut p = [0u8; 64];
        for (i, limb) in P.iter().enumerate() {
            p[56 - 8 * i..64 - 8 * i].copy_from_slice(&limb.to_be_bytes());
        }
        assert_eq!(mod_p(&p), [0u8; 48]);
        p[63] += 5;
        let mut five = [0u8; 48];
        five[47] = 5;
        assert_eq!(mod_p(&p), five);
    }

    fn limbs(b: &[u8; 48]) -> [u64; 6] {
        let mut r = [0u64; 6];
        for (i, limb) in r.iter_mut().enumerate() {
            *limb = u64::from_be_bytes(b[40 - 8 * i..48 - 8 * i].try_into().unwrap());
        }
        r
    }
}
