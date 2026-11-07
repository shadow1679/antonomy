//! Pheromone staking. A wallet locks tokens on a (colony, option) pair. Influence
//! is `isqrt(stake)` per wallet, summed per option. One wallet budget covers all
//! colonies: total locked per wallet is capped, so spreading it over several
//! options lowers the weight on each. Staking closes at `close_at`, which must
//! come before the drand round is published at `publish_at`.
//!
//! Sybil caveat: weights are per wallet, and isqrt is concave, so splitting one
//! stake over k wallets multiplies influence by about sqrt(k). Nothing here
//! prevents that.

use crate::{isqrt, ledger::AccountId, ledger::Ledger, Error};
use antosim::sha256;
use std::collections::BTreeMap;

/// Account that holds locked stake.
pub const VAULT: &str = "stake-vault.antonomy";
pub const SNAPSHOT_TAG: &[u8] = b"ANTO-STAKE-v0";

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
        })
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
        if now >= self.cfg.close_at || self.settled {
            return Err(Error::StakingClosed);
        }
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
    pub fn unstake(
        &mut self,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        if now >= self.cfg.close_at && !self.settled {
            return Err(Error::Locked);
        }
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

    /// Final stake snapshot and its hash. Only available once staking has closed,
    /// so the hash that goes into the seed cannot change afterwards.
    pub fn snapshot(&self, now: u64) -> Result<Snapshot, Error> {
        if now < self.cfg.close_at {
            return Err(Error::StakingStillOpen);
        }
        let entries: Vec<Entry> = self
            .stakes
            .iter()
            .map(|((a, c, o), v)| (a.clone(), *c, *o, *v))
            .collect();
        let hash = hash_entries(&entries);
        Ok(Snapshot { entries, hash })
    }

    /// Square-root weight per option for one colony: sum over wallets of
    /// `isqrt(stake)`. The sim has no stake input yet; this is what it will read.
    pub fn weights(&self, colony: u16, n_options: usize) -> Vec<u128> {
        let mut w = vec![0u128; n_options];
        for ((_, c, o), v) in &self.stakes {
            if *c == colony && (*o as usize) < n_options {
                w[*o as usize] += isqrt(*v);
            }
        }
        w
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
        s.stake(&mut l, 99, "alice", 0, 0, ONE).unwrap();
        assert_eq!(
            s.stake(&mut l, 100, "alice", 0, 0, ONE),
            Err(Error::StakingClosed)
        );
    }

    #[test]
    fn unstake_only_before_close_or_after_settle() {
        let (mut l, mut s) = setup();
        s.stake(&mut l, 1, "alice", 0, 0, 10 * ONE).unwrap();
        s.unstake(&mut l, 50, "alice", 0, 0, 4 * ONE).unwrap();
        assert_eq!(s.staked_by("alice"), 6 * ONE);
        assert_eq!(
            s.unstake(&mut l, 100, "alice", 0, 0, ONE),
            Err(Error::Locked)
        );
        assert_eq!(s.settle(119), Err(Error::NotPublished));
        s.settle(120).unwrap();
        s.unstake(&mut l, 121, "alice", 0, 0, 6 * ONE).unwrap();
        assert_eq!(l.ft_balance_of("alice"), 1000 * ONE);
        assert_eq!(l.ft_balance_of(VAULT), 0);
        assert_eq!(s.staked_by("alice"), 0);
        assert_eq!(
            s.stake(&mut l, 121, "alice", 0, 0, ONE),
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
        s1.stake(&mut l1, 1, "alice", 0, 1, 5 * ONE).unwrap();
        s1.stake(&mut l1, 2, "bob", 0, 2, 7 * ONE).unwrap();
        s1.stake(&mut l1, 3, "alice", 1, 0, 2 * ONE).unwrap();
        // Same final stakes, different order, plus an unstaked-and-restaked amount.
        s2.stake(&mut l2, 1, "alice", 1, 0, 2 * ONE).unwrap();
        s2.stake(&mut l2, 2, "bob", 0, 2, 9 * ONE).unwrap();
        s2.unstake(&mut l2, 3, "bob", 0, 2, 2 * ONE).unwrap();
        s2.stake(&mut l2, 4, "alice", 0, 1, 5 * ONE).unwrap();
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
            s.stake(&mut l, 1, acct, 0, opt, amt).unwrap();
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
}
