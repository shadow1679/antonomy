//! $ANTO token logic, kept free of any chain SDK so it can be unit-tested here
//! and wrapped by the NEAR contract later. Integer-only and deterministic:
//! all maps are `BTreeMap`, so iteration order is fixed.
//!
//! `market` holds the forecast market registry: keepers post the trending list
//! and odds, and the contract keeps the per-outcome median. `burn` is the
//! Burn colony's daily pot (part burned, part paid to stakers by `reward`),
//! and `day` its burn-day schedule and the one-day stake lock.
//! `request` and `agents` are Recruit the swarm: requested forecasts paid in
//! $ANTO, and the forecaster agents whose median odds feed the Agents colony.
//!
//! The drand commit lives in the contract (`contract/src/drand.rs`), which
//! needs NEAR's BLS12-381 host functions; this crate takes its randomness as
//! plain `entropy` bytes.

/// The sim, re-exported so the contract can re-run a result in its tests.
pub use antosim;

pub mod agents;
pub mod burn;
pub mod burnrun;
pub mod day;
pub mod ledger;
pub mod market;
pub mod random;
pub mod request;
pub mod reward;
pub mod round;
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
    /// Burn already executed for this burn day or a later one.
    AlreadyBurned(u64),
    /// That burn day's colony is still running (it ends at 24:00 UTC).
    BurnDayNotOver(u64),
    /// No frozen Burn colony stakes for that day: it was skipped (no call
    /// between its 12:00 and the next day's) or already burned.
    NoBurnSnapshot(u64),
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
    /// Unstake while the round is running and not yet settled, or a Burn
    /// stake before its day's pot has paid.
    Locked,
    /// Settle before the drand round is published.
    NotPublished,
    /// Keeper list must be non-empty and distinct, with a strict-majority quorum.
    BadKeeperConfig,
    /// Only allow-listed keepers may post markets.
    NotKeeper,
    /// Market list or market fails validation (ids, outcomes, odds).
    BadMarket,
    /// Market posting is closed (post) or still open (finalize).
    PostingClosed,
    PostingStillOpen,
    /// No market list was posted by at least `quorum` keepers.
    NoQuorum,
    AlreadyFinalized,
    /// Rewards already paid for this burn day or a later one.
    AlreadyRewarded(u64),
    /// Request fee split doesn't fit the fee, or the fee is zero.
    BadRequestConfig,
    /// The requested slug contains a deny-listed word.
    DeniedMarket,
    NoSuchRequest(u32),
    TooManyRequests,
    /// The request is not waiting for a crank (odds still open, done or skipped).
    NotCrankable,
    /// Not a request colony, or not a colony agents can post on.
    BadColony,
    AlreadyRegistered,
    /// Only registered forecaster agents may post forecasts.
    NotAgent,
    /// Agent odds must be one value per outcome summing to 10000.
    BadForecast,
    /// Option index outside the market's outcomes.
    BadOption,
    /// The Burn colony of this day can only run between 12:00 and 24:00 UTC.
    BurnNotRunning(u64),
    /// A crank had nothing to do: the clock allows no new tick, or the run is done.
    NothingToCrank,
    /// That burn day's colony has not run its last tick yet.
    BurnNotFinished(u64),
    /// No Burn colony run is stored for that day.
    NoBurnRun(u64),
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

/// floor(a * b / d) with a 256-bit intermediate, for `b <= d` so the result
/// fits (it is at most `a`). Shift-and-subtract long division, no float.
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0 && b <= d, "mul_div needs 0 < d and b <= d");
    // 256-bit product as (hi, lo) from 64-bit limbs.
    let (a1, a0) = (a >> 64, a & u64::MAX as u128);
    let (b1, b0) = (b >> 64, b & u64::MAX as u128);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & u64::MAX as u128) + (p10 & u64::MAX as u128);
    let lo = (p00 & u64::MAX as u128) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    let (mut q, mut r) = (0u128, 0u128);
    for i in (0..256).rev() {
        let bit = if i >= 128 {
            (hi >> (i - 128)) & 1
        } else {
            (lo >> i) & 1
        };
        let carry = r >> 127;
        r = (r << 1) | bit;
        q <<= 1;
        if carry == 1 || r >= d {
            r = r.wrapping_sub(d);
            q |= 1;
        }
    }
    q
}

#[cfg(test)]
mod tests {
    use super::{isqrt, mul_div};

    #[test]
    fn mul_div_matches_narrow_math_and_handles_wide() {
        for (a, b, d) in [
            (0, 0, 1),
            (10, 3, 7),
            (1000, 1, 3),
            (u64::MAX as u128, 5, 9),
        ] {
            assert_eq!(mul_div(a, b, d), a * b / d, "{a} {b} {d}");
        }
        let one = 10u128.pow(24);
        assert_eq!(mul_div(50_000 * one, 100 * one, 400 * one), 12_500 * one);
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
        assert_eq!(mul_div(u128::MAX, u128::MAX - 1, u128::MAX), u128::MAX - 1);
        assert_eq!(mul_div(u128::MAX, 1, 2), u128::MAX / 2);
    }

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
