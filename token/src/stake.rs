//! Pheromone staking. A wallet locks tokens on a (colony, option) pair. Influence
//! is `isqrt(stake)` per wallet, summed per option. One wallet budget covers all
//! colonies: total locked per wallet is capped, so spreading it over several
//! options lowers the weight on each.
//!
//! Two schedules. Forecast colonies follow the round: staking closes at
//! `close_at`, which must come before the drand round is published at
//! `publish_at`, and `snapshot` is their frozen stake set. The Burn colony
//! follows burn days (`day`): its stakes stay in until withdrawn and count for
//! every day; at 12:00 UTC they freeze into that day's snapshot
//! (`burn_snapshot`), so a stake made after 12:00 counts from the next day.
//! Burn stakes can't be withdrawn from 12:00 to 24:00 UTC, while the run uses
//! them. Freezing is lazy: every call that changes stakes first freezes the
//! newest drawn day if it isn't yet, which gives the stakes as of its 12:00,
//! since nothing changed them in between. A day with no calls between its
//! 12:00 and the next day's 12:00 gets no snapshot and can't be burned.
//!
//! Requested markets (colony `0x8000 + id`, `request::REQUEST_COLONY_BASE`)
//! follow their request instead: `Requests::stake` and `Requests::unstake`
//! check its window and call `stake_request` / `unstake_request` here. They
//! are left out of the round's snapshot and its refunds.
//!
//! Sybil caveat: weights are per wallet, and isqrt is concave, so splitting one
//! stake over k wallets multiplies influence by about sqrt(k). Nothing here
//! prevents that.

use crate::{day, isqrt, ledger::AccountId, ledger::Ledger, request::REQUEST_COLONY_BASE, Error};
use antosim::{sha256, BURN_COLONY};
use std::collections::BTreeMap;

/// Account that holds locked stake.
pub const VAULT: &str = "stake-vault.antonomy";
pub const SNAPSHOT_TAG: &[u8] = b"ANTO-STAKE-v0";
/// sqrt-yocto per milli sqrt-token: isqrt(10^24) / 1000.
const SIM_WEIGHT_DIV: u128 = 1_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct StakeConfig {
    /// Most one wallet may have locked in total, across all colonies.
    pub cap_per_wallet: u128,
    /// Staking and early unstaking allowed while `now < close_at`.
    pub close_at: u64,
    /// The committed drand round is published at this time.
    pub publish_at: u64,
}

pub type Entry = (AccountId, u16, u8, u128);

/// True for a requested market's colony, which stakes on its request's clock.
pub fn is_request_colony(colony: u16) -> bool {
    colony >= REQUEST_COLONY_BASE
}

/// Colonies the round's schedule, snapshot and refunds cover.
fn round_colony(colony: u16) -> bool {
    colony != BURN_COLONY && !is_request_colony(colony)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// Sorted by (account, colony, option); zero stakes omitted.
    pub entries: Vec<Entry>,
    pub hash: [u8; 32],
}

#[derive(Debug, Clone)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Staking {
    cfg: StakeConfig,
    stakes: BTreeMap<(AccountId, u16, u8), u128>,
    wallet_total: BTreeMap<AccountId, u128>,
    settled: bool,
    /// Burn colony stakes frozen at each drawn day's 12:00, until burned.
    burn_days: BTreeMap<u64, Vec<Entry>>,
    /// Newest day frozen so far.
    burn_frozen_to: Option<u64>,
}

impl Staking {
    pub fn new(cfg: StakeConfig) -> Result<Staking, Error> {
        if cfg.close_at >= cfg.publish_at {
            return Err(Error::BadSchedule);
        }
        Ok(Staking {
            cfg,
            stakes: BTreeMap::new(),
            wallet_total: BTreeMap::new(),
            settled: false,
            burn_days: BTreeMap::new(),
            burn_frozen_to: None,
        })
    }

    pub fn config(&self) -> StakeConfig {
        self.cfg
    }

    pub fn staked_by(&self, who: &str) -> u128 {
        self.wallet_total.get(who).copied().unwrap_or(0)
    }

    pub fn stake(
        &mut self,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        self.roll(now);
        if is_request_colony(colony) {
            return Err(Error::BadColony);
        }
        if colony != BURN_COLONY && (now >= self.cfg.close_at || self.settled) {
            return Err(Error::StakingClosed);
        }
        self.lock(ledger, who, colony, option, amount)
    }

    /// Stake on a requested market's colony. `Requests::stake` checks the
    /// request's window first.
    pub(crate) fn stake_request(
        &mut self,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        self.roll(now);
        self.lock(ledger, who, colony, option, amount)
    }

    fn lock(
        &mut self,
        ledger: &mut Ledger,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        if amount == 0 {
            return Err(Error::ZeroAmount);
        }
        let would_be = self
            .staked_by(who)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        if would_be > self.cfg.cap_per_wallet {
            return Err(Error::WalletCapExceeded {
                cap: self.cfg.cap_per_wallet,
                would_be,
            });
        }
        ledger.ft_transfer(who, VAULT, amount)?;
        let key = (who.to_string(), colony, option);
        // Cannot overflow: the entry is at most the wallet total, which passed the cap.
        *self.stakes.entry(key).or_insert(0) += amount;
        self.wallet_total.insert(who.to_string(), would_be);
        Ok(())
    }

    /// Withdraw before the window closes, or after the round has settled.
    /// Burn colony stakes: any time except 12:00 to 24:00 UTC.
    pub fn unstake(
        &mut self,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        self.roll(now);
        if is_request_colony(colony) {
            return Err(Error::BadColony);
        }
        let locked = if colony == BURN_COLONY {
            day::running(now)
        } else {
            now >= self.cfg.close_at && !self.settled
        };
        if locked {
            return Err(Error::Locked);
        }
        self.release(ledger, who, colony, option, amount)
    }

    /// Withdraw from a requested market's colony. `Requests::unstake` checks
    /// that the request isn't running on these stakes.
    pub(crate) fn unstake_request(
        &mut self,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        self.roll(now);
        self.release(ledger, who, colony, option, amount)
    }

    fn release(
        &mut self,
        ledger: &mut Ledger,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        if amount == 0 {
            return Err(Error::ZeroAmount);
        }
        let key = (who.to_string(), colony, option);
        let have = self.stakes.get(&key).copied().unwrap_or(0);
        if have < amount {
            return Err(Error::InsufficientStake { have, need: amount });
        }
        ledger.ft_transfer(VAULT, who, amount)?;
        if have == amount {
            self.stakes.remove(&key);
        } else {
            self.stakes.insert(key, have - amount);
        }
        let total = self.staked_by(who) - amount;
        if total == 0 {
            self.wallet_total.remove(who);
        } else {
            self.wallet_total.insert(who.to_string(), total);
        }
        Ok(())
    }

    /// Mark the round done so stakers can withdraw. Needs the drand round to be public.
    pub fn settle(&mut self, now: u64) -> Result<(), Error> {
        if now < self.cfg.publish_at {
            return Err(Error::NotPublished);
        }
        self.settled = true;
        Ok(())
    }

    /// Start the next round with a new schedule. Every forecast colony stake
    /// goes back to its owner (the markets of the new round are different, so
    /// old stakes would point at the wrong outcomes); Burn colony stakes and
    /// requested markets' stakes stay.
    /// Returns the refunds.
    pub fn reopen(
        &mut self,
        ledger: &mut Ledger,
        cfg: StakeConfig,
    ) -> Result<Vec<(AccountId, u128)>, Error> {
        if cfg.close_at >= cfg.publish_at {
            return Err(Error::BadSchedule);
        }
        let old: Vec<((AccountId, u16, u8), u128)> = self
            .stakes
            .iter()
            .filter(|((_, c, _), _)| round_colony(*c))
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        let mut refunds: BTreeMap<AccountId, u128> = BTreeMap::new();
        for ((who, _, _), v) in &old {
            *refunds.entry(who.clone()).or_insert(0) += v;
        }
        for (who, v) in &refunds {
            ledger.ft_transfer(VAULT, who, *v)?;
            let total = self.staked_by(who) - v;
            if total == 0 {
                self.wallet_total.remove(who);
            } else {
                self.wallet_total.insert(who.clone(), total);
            }
        }
        for (k, _) in old {
            self.stakes.remove(&k);
        }
        self.cfg = cfg;
        self.settled = false;
        Ok(refunds.into_iter().collect())
    }

    /// The round's final stake snapshot and its hash: every colony but the
    /// Burn colony, which has its own per-day snapshot, and the requested
    /// markets, which have theirs (`colony_snapshot`). Only available once
    /// staking has closed, so the hash that goes into the seed cannot change
    /// afterwards.
    pub fn snapshot(&self, now: u64) -> Result<Snapshot, Error> {
        if now < self.cfg.close_at {
            return Err(Error::StakingStillOpen);
        }
        Ok(Snapshot::of(self.entries(round_colony)))
    }

    /// One colony's stakes as they stand and their hash. A requested market
    /// freezes this when its seed is drawn.
    pub fn colony_snapshot(&self, colony: u16) -> Snapshot {
        Snapshot::of(self.entries(|c| c == colony))
    }

    fn entries(&self, keep: impl Fn(u16) -> bool) -> Vec<Entry> {
        self.stakes
            .iter()
            .filter(|((_, c, _), _)| keep(*c))
            .map(|((a, c, o), v)| (a.clone(), *c, *o, *v))
            .collect()
    }

    /// Freeze the newest drawn day's Burn colony stakes if not done yet.
    /// Called before anything that changes stakes.
    fn roll(&mut self, now: u64) {
        if let Some(d) = day::drawn_day(now) {
            if self.burn_frozen_to.is_none_or(|f| f < d) {
                let e = self.entries(|c| c == BURN_COLONY);
                self.burn_days.insert(d, e);
                self.burn_frozen_to = Some(d);
            }
        }
    }

    /// Burn colony stakes as of `day`'s 12:00 UTC, and their hash: the stake
    /// input of that day's colony. Errors before then, and for a day that was
    /// skipped or has already been burned.
    pub fn burn_snapshot(&self, burn_day: u64, now: u64) -> Result<Snapshot, Error> {
        if day::drawn_day(now).is_none_or(|d| d < burn_day) {
            return Err(Error::StakingStillOpen);
        }
        if let Some(e) = self.burn_days.get(&burn_day) {
            return Ok(Snapshot::of(e.clone()));
        }
        // Drawn but not frozen yet: nothing has changed stakes since its 12:00.
        if day::drawn_day(now) == Some(burn_day) && self.burn_frozen_to.is_none_or(|f| f < burn_day) {
            return Ok(Snapshot::of(self.entries(|c| c == BURN_COLONY)));
        }
        Err(Error::NoBurnSnapshot(burn_day))
    }

    /// `burn_snapshot` after making sure the newest drawn day is frozen into
    /// storage, so the day can still be burned and rewarded after the next
    /// 12:00 even if no stake changed in between. The Burn colony run calls
    /// this when it starts.
    pub fn freeze_burn(&mut self, burn_day: u64, now: u64) -> Result<Snapshot, Error> {
        self.roll(now);
        self.burn_snapshot(burn_day, now)
    }

    /// `burn_snapshot`, then forget that day and every earlier one: a burn
    /// day is used once, and days are burned in order.
    pub fn take_burn_snapshot(&mut self, burn_day: u64, now: u64) -> Result<Snapshot, Error> {
        self.roll(now);
        let s = self.burn_snapshot(burn_day, now)?;
        self.burn_days = self.burn_days.split_off(&(burn_day + 1));
        Ok(s)
    }

    /// Square-root weight per option for one colony: sum over wallets of
    /// `isqrt(stake)`, in sqrt-yocto units. `sim_weights` converts it for the sim.
    pub fn weights(&self, colony: u16, n_options: usize) -> Vec<u128> {
        let mut w = vec![0u128; n_options];
        for ((_, c, o), v) in &self.stakes {
            if *c == colony && (*o as usize) < n_options {
                w[*o as usize] += isqrt(*v);
            }
        }
        w
    }

    /// Raw stake per option for one colony. The reward pot is split by raw
    /// stake, while the sim reads the square-root `weights`.
    pub fn totals(&self, colony: u16, n_options: usize) -> Vec<u128> {
        let mut t = vec![0u128; n_options];
        for ((_, c, o), v) in &self.stakes {
            if *c == colony && (*o as usize) < n_options {
                t[*o as usize] += *v;
            }
        }
        t
    }

    /// One wallet's entries as (colony, option, amount), sorted. Readable while
    /// staking is open, unlike the snapshot.
    pub fn stakes_of(&self, who: &str) -> Vec<(u16, u8, u128)> {
        let lo = (who.to_string(), 0, 0);
        let hi = (who.to_string(), u16::MAX, u8::MAX);
        self.stakes
            .range(lo..=hi)
            .map(|((_, c, o), v)| (*c, *o, *v))
            .collect()
    }

    /// `weights` in the unit the sim reads: milli sqrt-tokens, saturating at
    /// `u32::MAX`. One token (10^24 yocto) has `isqrt` 10^12, so the divisor is 10^9.
    pub fn sim_weights(&self, colony: u16, n_options: usize) -> Vec<u32> {
        self.weights(colony, n_options)
            .into_iter()
            .map(|w| u32::try_from(w / SIM_WEIGHT_DIV).unwrap_or(u32::MAX))
            .collect()
    }
}

/// Sim weights (milli sqrt-tokens per option, five menu options) of a Burn
/// colony snapshot: the sum over its entries of `isqrt(stake)`, the same
/// unit as `Staking::sim_weights`. Entries of other colonies are ignored.
pub fn burn_weights(entries: &[Entry]) -> Vec<u32> {
    let mut w = vec![0u128; 5];
    for (_, c, o, v) in entries {
        if *c == BURN_COLONY && (*o as usize) < 5 {
            w[*o as usize] += isqrt(*v);
        }
    }
    w.into_iter()
        .map(|x| u32::try_from(x / SIM_WEIGHT_DIV).unwrap_or(u32::MAX))
        .collect()
}

impl Snapshot {
    fn of(entries: Vec<Entry>) -> Snapshot {
        let hash = hash_entries(&entries);
        Snapshot { entries, hash }
    }
}

pub fn hash_hex(hash: &[u8; 32]) -> String {
    antosim::to_hex(hash)
}

/// sha256(tag || count u32 || per entry: len u16, account bytes, colony u16, option u8, amount u128), big-endian.
pub fn hash_entries(entries: &[Entry]) -> [u8; 32] {
    let mut buf = Vec::new();
    buf.extend_from_slice(SNAPSHOT_TAG);
    buf.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (a, c, o, v) in entries {
        buf.extend_from_slice(&(a.len() as u16).to_be_bytes());
        buf.extend_from_slice(a.as_bytes());
        buf.extend_from_slice(&c.to_be_bytes());
        buf.push(*o);
        buf.extend_from_slice(&v.to_be_bytes());
    }
    sha256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ONE;

    const CFG: StakeConfig = StakeConfig {
        cap_per_wallet: 100 * ONE,
        close_at: 100,
        publish_at: 120,
    };

    fn setup() -> (Ledger, Staking) {
        let mut l = Ledger::new("treasury", 1_000_000 * ONE);
        for w in ["alice", "bob", "carol"] {
            l.ft_transfer("treasury", w, 1000 * ONE).unwrap();
        }
        (l, Staking::new(CFG).unwrap())
    }

    #[test]
    fn schedule_must_close_before_publish() {
        let bad = StakeConfig {
            close_at: 50,
            publish_at: 50,
            ..CFG
        };
        assert_eq!(Staking::new(bad).unwrap_err(), Error::BadSchedule);
    }

    #[test]
    fn stake_locks_tokens_in_vault() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 10, "alice", 0, 2, 25 * ONE).unwrap();
        assert_eq!(l.ft_balance_of("alice"), 975 * ONE);
        assert_eq!(l.ft_balance_of(VAULT), 25 * ONE);
        assert_eq!(s.staked_by("alice"), 25 * ONE);
    }

    #[test]
    fn weight_is_square_root_of_stake() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 1, 4 * ONE).unwrap();
        s.stake(&mut l, 1, "bob", 0, 1, 16 * ONE).unwrap();
        // 4x the stake gives 2x the weight.
        let w = s.weights(0, 3);
        assert_eq!(w[1], isqrt(4 * ONE) + isqrt(16 * ONE));
        assert_eq!(isqrt(16 * ONE), 2 * isqrt(4 * ONE));
        assert_eq!(w[0], 0);
        assert_eq!(s.weights(1, 3), vec![0, 0, 0]);
    }

    #[test]
    fn totals_and_stakes_of_read_raw_amounts() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 1, 4 * ONE).unwrap();
        s.stake(&mut l, 1, "bob", 0, 1, 16 * ONE).unwrap();
        s.stake(&mut l, 1, "alice", 1, 0, 3 * ONE).unwrap();
        s.stake(&mut l, 1, "alice", 0, 4, 2 * ONE).unwrap();
        assert_eq!(s.totals(0, 3), vec![0, 20 * ONE, 0]);
        assert_eq!(s.totals(1, 2), vec![3 * ONE, 0]);
        assert_eq!(
            s.stakes_of("alice"),
            vec![(0, 1, 4 * ONE), (0, 4, 2 * ONE), (1, 0, 3 * ONE)]
        );
        assert_eq!(s.stakes_of("al"), vec![]);
        assert_eq!(s.stakes_of("carol"), vec![]);
    }

    #[test]
    fn sim_weights_are_milli_sqrt_tokens() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 1, 4 * ONE).unwrap();
        s.stake(&mut l, 1, "bob", 0, 1, 16 * ONE).unwrap();
        // sqrt(4) + sqrt(16) = 6 tokens-worth of weight = 6000 milli.
        assert_eq!(s.sim_weights(0, 3), vec![0, 6000, 0]);
    }

    #[test]
    fn one_wallet_budget_across_colonies_and_cap_is_hard() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 0, 60 * ONE).unwrap();
        // Second colony draws on the same 100-token wallet cap.
        assert_eq!(
            s.stake(&mut l, 1, "alice", 1, 0, 41 * ONE),
            Err(Error::WalletCapExceeded {
                cap: 100 * ONE,
                would_be: 101 * ONE
            })
        );
        s.stake(&mut l, 1, "alice", 1, 0, 40 * ONE).unwrap();
        // The rejected stake moved nothing.
        assert_eq!(l.ft_balance_of("alice"), 900 * ONE);
    }

    #[test]
    fn spreading_one_budget_lowers_weight_on_each_option() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 0, 50 * ONE).unwrap();
        s.stake(&mut l, 1, "alice", 0, 1, 50 * ONE).unwrap();
        s.stake(&mut l, 1, "bob", 0, 2, 100 * ONE).unwrap();
        let w = s.weights(0, 3);
        assert!(w[0] < w[2] && w[1] < w[2]);
    }

    #[test]
    fn splitting_across_wallets_raises_influence_sybil_is_open() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 0, 100 * ONE).unwrap(); // one wallet, full cap
        s.stake(&mut l, 1, "bob", 0, 1, 50 * ONE).unwrap(); // same total, two wallets
        s.stake(&mut l, 1, "carol", 0, 1, 50 * ONE).unwrap();
        let w = s.weights(0, 2);
        assert!(w[1] > w[0], "isqrt rewards splitting: {w:?}");
    }

    #[test]
    fn staking_closes_at_close_at() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 99, "alice", 1, 0, ONE).unwrap();
        assert_eq!(
            s.stake(&mut l, 100, "alice", 1, 0, ONE),
            Err(Error::StakingClosed)
        );
    }

    #[test]
    fn unstake_only_before_close_or_after_settle() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 1, 0, 10 * ONE).unwrap();
        s.unstake(&mut l, 50, "alice", 1, 0, 4 * ONE).unwrap();
        assert_eq!(s.staked_by("alice"), 6 * ONE);
        assert_eq!(
            s.unstake(&mut l, 100, "alice", 1, 0, ONE),
            Err(Error::Locked)
        );
        assert_eq!(s.settle(119), Err(Error::NotPublished));
        s.settle(120).unwrap();
        s.unstake(&mut l, 121, "alice", 1, 0, 6 * ONE).unwrap();
        assert_eq!(l.ft_balance_of("alice"), 1000 * ONE);
        assert_eq!(l.ft_balance_of(VAULT), 0);
        assert_eq!(s.staked_by("alice"), 0);
        assert_eq!(
            s.stake(&mut l, 121, "alice", 1, 0, ONE),
            Err(Error::StakingClosed)
        );
    }

    #[test]
    fn unstake_more_than_staked_fails() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 0, 10 * ONE).unwrap();
        assert_eq!(
            s.unstake(&mut l, 2, "alice", 0, 0, 11 * ONE),
            Err(Error::InsufficientStake {
                have: 10 * ONE,
                need: 11 * ONE
            })
        );
        assert_eq!(
            s.unstake(&mut l, 2, "alice", 0, 1, ONE),
            Err(Error::InsufficientStake { have: 0, need: ONE })
        );
    }

    #[test]
    fn snapshot_waits_for_close_and_ignores_call_order() {
        let (mut l1, mut s1) = setup();
        let (mut l2, mut s2) = setup();
        s1.stake(&mut l1, 1, "alice", 1, 1, 5 * ONE).unwrap();
        s1.stake(&mut l1, 2, "bob", 1, 2, 7 * ONE).unwrap();
        s1.stake(&mut l1, 3, "alice", 2, 0, 2 * ONE).unwrap();
        // Same final stakes, different order, plus an unstaked-and-restaked amount.
        s2.stake(&mut l2, 1, "alice", 2, 0, 2 * ONE).unwrap();
        s2.stake(&mut l2, 2, "bob", 1, 2, 9 * ONE).unwrap();
        s2.unstake(&mut l2, 3, "bob", 1, 2, 2 * ONE).unwrap();
        s2.stake(&mut l2, 4, "alice", 1, 1, 5 * ONE).unwrap();
        assert_eq!(s1.snapshot(99), Err(Error::StakingStillOpen));
        let a = s1.snapshot(100).unwrap();
        let b = s2.snapshot(100).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.entries.len(), 3);
    }

    #[test]
    fn snapshot_hash_changes_with_any_stake() {
        let hash_for = |acct: &str, opt: u8, amt: u128| {
            let (mut l, mut s) = setup();
            s.stake(&mut l, 1, acct, 1, opt, amt).unwrap();
            s.snapshot(100).unwrap().hash
        };
        let base = hash_for("alice", 1, 5 * ONE);
        assert_eq!(base, hash_for("alice", 1, 5 * ONE));
        assert_ne!(base, hash_for("alice", 1, 5 * ONE + 1));
        assert_ne!(base, hash_for("alice", 2, 5 * ONE));
        assert_ne!(base, hash_for("bob", 1, 5 * ONE));
        // Empty snapshot still hashes (tag + zero count).
        let (_, s) = setup();
        assert_eq!(s.snapshot(100).unwrap().hash, hash_entries(&[]));
    }

    // Burn days: day 20745 is 2026-10-19.
    const D: u64 = 20_745;
    fn at(d: u64, h: u64) -> u64 {
        d * day::DAY_MS + h * 3_600_000
    }

    #[test]
    fn burn_stakes_ignore_the_round_close() {
        let (mut l, mut s) = setup();
        let late = at(D, 3);
        assert!(late > CFG.publish_at);
        s.settle(late).unwrap();
        s.stake(&mut l, late, "alice", BURN_COLONY, 2, 5 * ONE).unwrap();
        assert_eq!(
            s.stake(&mut l, late, "alice", 1, 2, ONE),
            Err(Error::StakingClosed)
        );
        // The round snapshot leaves the Burn colony out.
        assert!(s.snapshot(late).unwrap().entries.is_empty());
    }

    #[test]
    fn burn_snapshot_freezes_at_noon() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, at(D, 9), "alice", BURN_COLONY, 2, 5 * ONE).unwrap();
        assert_eq!(s.burn_snapshot(D, at(D, 11)), Err(Error::StakingStillOpen));
        // At 12:00 the day's stakes are the ones in so far, even before any call.
        let noon = s.burn_snapshot(D, at(D, 12)).unwrap();
        assert_eq!(noon.entries, vec![("alice".to_string(), BURN_COLONY, 2, 5 * ONE)]);
        // A stake after 12:00 counts from the next day, not this one.
        s.stake(&mut l, at(D, 13), "bob", BURN_COLONY, 4, 3 * ONE).unwrap();
        assert_eq!(s.burn_snapshot(D, at(D, 14)).unwrap(), noon);
        assert_eq!(s.burn_snapshot(D + 1, at(D + 1, 12)).unwrap().entries.len(), 2);
        // Other colonies never enter the Burn snapshot.
        s.stake(&mut l, at(D, 15), "carol", 1, 0, ONE).unwrap_err(); // round closed
        assert_ne!(noon.hash, s.burn_snapshot(D + 1, at(D + 1, 12)).unwrap().hash);
    }

    #[test]
    fn burn_stakes_locked_while_the_colony_runs() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, at(D, 1), "alice", BURN_COLONY, 2, 5 * ONE).unwrap();
        s.unstake(&mut l, at(D, 2), "alice", BURN_COLONY, 2, ONE).unwrap();
        for h in [12, 18, 23] {
            assert_eq!(
                s.unstake(&mut l, at(D, h), "alice", BURN_COLONY, 2, ONE),
                Err(Error::Locked)
            );
        }
        s.unstake(&mut l, at(D + 1, 0), "alice", BURN_COLONY, 2, 4 * ONE).unwrap();
        // The withdrawal after 24:00 doesn't reach back into the frozen day.
        assert_eq!(s.burn_snapshot(D, at(D + 1, 0)).unwrap().entries[0].3, 4 * ONE);
        assert_eq!(l.ft_balance_of("alice"), 1000 * ONE);
    }

    #[test]
    fn burn_snapshot_is_taken_once_and_in_order() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, at(D, 1), "alice", BURN_COLONY, 2, 5 * ONE).unwrap();
        s.stake(&mut l, at(D, 13), "alice", BURN_COLONY, 3, ONE).unwrap(); // freezes D
        s.stake(&mut l, at(D + 1, 13), "alice", BURN_COLONY, 3, ONE).unwrap(); // freezes D + 1
        let late = at(D + 2, 1);
        assert_eq!(s.take_burn_snapshot(D + 1, late).unwrap().entries.len(), 2);
        // Taking D + 1 dropped it and every day before it.
        assert_eq!(s.take_burn_snapshot(D + 1, late), Err(Error::NoBurnSnapshot(D + 1)));
        assert_eq!(s.burn_snapshot(D, late), Err(Error::NoBurnSnapshot(D)));
    }

    #[test]
    fn a_day_with_no_calls_is_skipped() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, at(D, 1), "alice", BURN_COLONY, 2, 5 * ONE).unwrap();
        // Next call two days later: only the newest drawn day gets frozen.
        s.stake(&mut l, at(D + 2, 13), "bob", BURN_COLONY, 1, ONE).unwrap();
        assert_eq!(s.burn_snapshot(D, at(D + 2, 14)), Err(Error::NoBurnSnapshot(D)));
        assert_eq!(s.burn_snapshot(D + 2, at(D + 2, 14)).unwrap().entries.len(), 1);
    }
}
