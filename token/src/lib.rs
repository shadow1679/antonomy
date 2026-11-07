//! $ANTO token logic, kept free of any chain SDK so it can be unit-tested here
//! and wrapped by the NEAR contract later. Integer-only and deterministic:
//! all maps are `BTreeMap`, so iteration order is fixed.
//!
//! Not covered yet: how stake weights feed the sim (the sim has no stake
//! input; see `Staking::weights`), rewards, and the drand commit.

pub mod burn;
pub mod ledger;
pub mod stake;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Amount must be greater than zero.
    ZeroAmount,
    InsufficientBalance {
        have: u128,
        need: u128,
    },
    /// Unstake asked for more than the wallet has staked there.
    InsufficientStake {
        have: u128,
        need: u128,
    },
    Overflow,
    /// Burn menu index outside the menu.
    BadBurnIndex(usize),
    /// Burn already executed for this round.
    AlreadyBurned(u64),
    /// Wallet total stake would exceed the per-wallet cap.
    WalletCapExceeded {
        cap: u128,
        would_be: u128,
    },
    /// Staking window is closed (stake) or still open (snapshot).
    StakingClosed,
    StakingStillOpen,
    /// Config must have `close_at < publish_at`.
    BadSchedule,
    /// Unstake while the round is running and not yet settled.
    Locked,
    /// Settle before the drand round is published.
    NotPublished,
}

/// Integer square root, floor. Newton's method, no float.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[cfg(test)]
mod tests {
    use super::isqrt;

    #[test]
    fn isqrt_is_floor_sqrt() {
        for n in 0u128..2000 {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "n={n}");
        }
        let r = isqrt(u128::MAX);
        assert_eq!(r, u64::MAX as u128);
        assert_eq!(isqrt(10u128.pow(36)), 10u128.pow(18));
        assert_eq!(isqrt(10u128.pow(36) - 1), 10u128.pow(18) - 1);
    }
}
