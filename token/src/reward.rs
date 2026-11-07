//! Play-token reward pool for the Burn colony. Anyone funds the pool; when the
//! colony picks a burn index, a fixed share of the pool goes to the wallets
//! staked on that index, pro rata to their stake.
//!
//! Burn colony only: forecast colonies never pay for being right (design doc
//! section 15). The pot is a fixed fraction of the pool, so the colony still
//! picks only an index and never an amount. Shares are by raw stake, not by
//! square-root weight, so splitting a stake over wallets earns nothing extra
//! here (it still buys influence in the sim, see `stake`). Rounding dust stays
//! in the pool. If nobody staked on the winning index, nothing is paid.
//!
//! This resembles prediction betting. Testnet play token only.

use crate::{ledger::AccountId, ledger::Ledger, mul_div, stake::Entry, Error};
use antosim::BURN_COLONY;
use std::collections::BTreeMap;

/// Account that holds the pool.
pub const POOL: &str = "reward-pool.antonomy";
/// Share of the pool paid out per burn day: 10%.
pub const ROUND_SHARE_BPS: u128 = 1_000;
const BPS_DENOM: u128 = 10_000;

#[derive(Debug, Clone, Default)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Rewards {
    last_day: Option<u64>,
    /// Lifetime rewards per account, for the leaderboard.
    earned: BTreeMap<AccountId, u128>,
}

impl Rewards {
    pub fn fund(&self, ledger: &mut Ledger, from: &str, amount: u128) -> Result<(), Error> {
        ledger.ft_transfer(from, POOL, amount)
    }

    pub fn pool(&self, ledger: &Ledger) -> u128 {
        ledger.ft_balance_of(POOL)
    }

    pub fn earned_by(&self, who: &str) -> u128 {
        self.earned.get(who).copied().unwrap_or(0)
    }

    /// (account, lifetime reward), highest first, ties by account.
    pub fn leaderboard(&self) -> Vec<(AccountId, u128)> {
        let mut v: Vec<_> = self.earned.iter().map(|(a, e)| (a.clone(), *e)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    }

    /// Pay this burn day's pot to the Burn colony stakers on `winner`.
    /// `entries` is the day's frozen stake snapshot. Once per day, in day
    /// order. Returns the payouts in
    /// snapshot order (sorted by account).
    pub fn distribute(
        &mut self,
        ledger: &mut Ledger,
        day: u64,
        winner: u8,
        entries: &[Entry],
    ) -> Result<Vec<(AccountId, u128)>, Error> {
        if self.last_day.is_some_and(|l| day <= l) {
            return Err(Error::AlreadyRewarded(day));
        }
        let winners: Vec<&Entry> = entries
            .iter()
            .filter(|(_, c, o, _)| *c == BURN_COLONY && *o == winner)
            .collect();
        let mut total: u128 = 0;
        for e in &winners {
            total = total.checked_add(e.3).ok_or(Error::Overflow)?;
        }
        let pot = mul_div(self.pool(ledger), ROUND_SHARE_BPS, BPS_DENOM);
        let mut paid = Vec::with_capacity(winners.len());
        if total > 0 && pot > 0 {
            for (who, _, _, stake) in winners {
                let share = mul_div(pot, *stake, total);
                if share == 0 {
                    continue;
                }
                ledger.ft_transfer(POOL, who, share)?;
                *self.earned.entry(who.clone()).or_insert(0) += share;
                paid.push((who.clone(), share));
            }
        }
        self.last_day = Some(day);
        Ok(paid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ONE;

    fn e(who: &str, colony: u16, option: u8, amount: u128) -> Entry {
        (who.to_string(), colony, option, amount)
    }

    fn funded(pool: u128) -> (Ledger, Rewards) {
        let mut l = Ledger::new("treasury", 1_000_000 * ONE);
        let r = Rewards::default();
        r.fund(&mut l, "treasury", pool).unwrap();
        (l, r)
    }

    #[test]
    fn pot_is_ten_percent_split_by_stake() {
        let (mut l, mut r) = funded(1000 * ONE);
        let snap = [
            e("alice", 0, 2, 30 * ONE),
            e("bob", 0, 2, 10 * ONE),
            e("carol", 0, 1, 50 * ONE),
        ];
        let paid = r.distribute(&mut l, 1, 2, &snap).unwrap();
        assert_eq!(
            paid,
            vec![("alice".into(), 75 * ONE), ("bob".into(), 25 * ONE)]
        );
        assert_eq!(r.pool(&l), 900 * ONE);
        assert_eq!(l.ft_balance_of("carol"), 0);
        assert_eq!(r.earned_by("alice"), 75 * ONE);
    }

    #[test]
    fn large_pool_and_stakes_do_not_overflow() {
        // pot * stake is about 10^57 here, past u128.
        let (mut l, mut r) = funded(500_000 * ONE);
        let snap = [e("a", 0, 0, 100 * ONE), e("b", 0, 0, 300 * ONE)];
        let paid = r.distribute(&mut l, 1, 0, &snap).unwrap();
        assert_eq!(
            paid,
            vec![("a".into(), 12_500 * ONE), ("b".into(), 37_500 * ONE)]
        );
    }

    #[test]
    fn forecast_colony_stakes_never_earn() {
        let (mut l, mut r) = funded(1000 * ONE);
        let snap = [e("alice", 1, 2, 30 * ONE), e("bob", 0, 2, 10 * ONE)];
        let paid = r.distribute(&mut l, 1, 2, &snap).unwrap();
        assert_eq!(paid, vec![("bob".into(), 100 * ONE)]);
        assert_eq!(l.ft_balance_of("alice"), 0);
    }

    #[test]
    fn no_winner_stake_pays_nothing_but_uses_the_day() {
        let (mut l, mut r) = funded(1000 * ONE);
        let snap = [e("alice", 0, 1, 30 * ONE)];
        assert_eq!(r.distribute(&mut l, 1, 4, &snap).unwrap(), vec![]);
        assert_eq!(r.pool(&l), 1000 * ONE);
        assert_eq!(
            r.distribute(&mut l, 1, 1, &snap),
            Err(Error::AlreadyRewarded(1))
        );
    }

    #[test]
    fn dust_stays_in_pool() {
        let (mut l, mut r) = funded(100);
        // Pot 10 split 1:1:1 is 3 each; 1 stays.
        let snap = [e("a", 0, 0, 1), e("b", 0, 0, 1), e("c", 0, 0, 1)];
        let paid = r.distribute(&mut l, 1, 0, &snap).unwrap();
        assert!(paid.iter().all(|(_, s)| *s == 3));
        assert_eq!(r.pool(&l), 91);
    }

    #[test]
    fn splitting_a_stake_earns_the_same() {
        let (mut l1, mut r1) = funded(1000 * ONE);
        let (mut l2, mut r2) = funded(1000 * ONE);
        let one = [e("whale", 0, 3, 100 * ONE), e("x", 0, 3, 100 * ONE)];
        let split = [
            e("whale1", 0, 3, 50 * ONE),
            e("whale2", 0, 3, 50 * ONE),
            e("x", 0, 3, 100 * ONE),
        ];
        r1.distribute(&mut l1, 1, 3, &one).unwrap();
        r2.distribute(&mut l2, 1, 3, &split).unwrap();
        assert_eq!(
            l1.ft_balance_of("whale"),
            l2.ft_balance_of("whale1") + l2.ft_balance_of("whale2")
        );
    }

    #[test]
    fn leaderboard_accumulates_over_days() {
        let (mut l, mut r) = funded(1000 * ONE);
        r.distribute(&mut l, 1, 0, &[e("bob", 0, 0, ONE)]).unwrap();
        r.distribute(&mut l, 2, 0, &[e("alice", 0, 0, ONE), e("bob", 0, 0, ONE)])
            .unwrap();
        // Round 1: bob 100. Round 2: pot 90, 45 each.
        assert_eq!(
            r.leaderboard(),
            vec![("bob".into(), 145 * ONE), ("alice".into(), 45 * ONE)]
        );
    }

    #[test]
    fn empty_pool_pays_nothing() {
        let mut l = Ledger::new("treasury", 1000);
        let mut r = Rewards::default();
        assert_eq!(r.distribute(&mut l, 1, 0, &[e("a", 0, 0, 5)]).unwrap(), vec![]);
    }
}
