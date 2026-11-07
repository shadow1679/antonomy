//! Burn colony rewards: the reward part of each day's pot (`burn::Pot`). When
//! the colony picks a pot size, that pot's reward part goes from the treasury
//! to the wallets staked on that size in the day's snapshot, pro rata to their
//! stake.
//!
//! Burn colony only: forecast colonies never pay for being right. The reward
//! is a fixed share of the treasury per menu entry, so the colony still picks
//! only an index and never an amount. Shares are by raw stake, not by
//! square-root weight, so splitting a stake over wallets earns nothing extra
//! here (it still buys influence in the sim, see `stake`). Crowding a size
//! dilutes each share, which pushes stakes towards the other sizes. Rounding
//! dust stays in the treasury. If nobody staked on the picked size, nothing is
//! paid and the reward stays in the treasury.
//!
//! This resembles prediction betting. Testnet play token only.

use crate::{ledger::AccountId, ledger::Ledger, mul_div, stake::Entry, Error};
use antosim::BURN_COLONY;
use std::collections::BTreeMap;

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
    pub fn earned_by(&self, who: &str) -> u128 {
        self.earned.get(who).copied().unwrap_or(0)
    }

    /// (account, lifetime reward), highest first, ties by account.
    pub fn leaderboard(&self) -> Vec<(AccountId, u128)> {
        let mut v: Vec<_> = self.earned.iter().map(|(a, e)| (a.clone(), *e)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    }

    /// Pay `reward` from `treasury` to the Burn colony stakers on `winner`.
    /// `entries` is the day's frozen stake snapshot. Once per day, in day
    /// order. Returns the payouts in snapshot order (sorted by account).
    pub fn distribute(
        &mut self,
        ledger: &mut Ledger,
        treasury: &str,
        day: u64,
        winner: u8,
        entries: &[Entry],
        reward: u128,
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
        let mut paid = Vec::with_capacity(winners.len());
        if total > 0 && reward > 0 {
            for (who, _, _, stake) in winners {
                let share = mul_div(reward, *stake, total);
                if share == 0 {
                    continue;
                }
                ledger.ft_transfer(treasury, who, share)?;
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

    fn treasury(balance: u128) -> (Ledger, Rewards) {
        (Ledger::new("treasury", balance), Rewards::default())
    }

    #[test]
    fn reward_is_split_by_stake_among_the_winners() {
        let (mut l, mut r) = treasury(1000 * ONE);
        let snap = [
            e("alice", 0, 2, 30 * ONE),
            e("bob", 0, 2, 10 * ONE),
            e("carol", 0, 1, 50 * ONE),
        ];
        let paid = r.distribute(&mut l, "treasury", 1, 2, &snap, 100 * ONE).unwrap();
        assert_eq!(
            paid,
            vec![("alice".into(), 75 * ONE), ("bob".into(), 25 * ONE)]
        );
        assert_eq!(l.ft_balance_of("treasury"), 900 * ONE);
        assert_eq!(l.ft_balance_of("carol"), 0);
        assert_eq!(r.earned_by("alice"), 75 * ONE);
    }

    #[test]
    fn large_rewards_and_stakes_do_not_overflow() {
        // reward * stake is about 10^57 here, past u128.
        let (mut l, mut r) = treasury(500_000 * ONE);
        let snap = [e("a", 0, 0, 100 * ONE), e("b", 0, 0, 300 * ONE)];
        let paid = r.distribute(&mut l, "treasury", 1, 0, &snap, 50_000 * ONE).unwrap();
        assert_eq!(
            paid,
            vec![("a".into(), 12_500 * ONE), ("b".into(), 37_500 * ONE)]
        );
    }

    #[test]
    fn forecast_colony_stakes_never_earn() {
        let (mut l, mut r) = treasury(1000 * ONE);
        let snap = [e("alice", 1, 2, 30 * ONE), e("bob", 0, 2, 10 * ONE)];
        let paid = r.distribute(&mut l, "treasury", 1, 2, &snap, 100 * ONE).unwrap();
        assert_eq!(paid, vec![("bob".into(), 100 * ONE)]);
        assert_eq!(l.ft_balance_of("alice"), 0);
    }

    #[test]
    fn no_winner_stake_pays_nothing_but_uses_the_day() {
        let (mut l, mut r) = treasury(1000 * ONE);
        let snap = [e("alice", 0, 1, 30 * ONE)];
        assert_eq!(r.distribute(&mut l, "treasury", 1, 4, &snap, 100 * ONE).unwrap(), vec![]);
        assert_eq!(l.ft_balance_of("treasury"), 1000 * ONE);
        assert_eq!(
            r.distribute(&mut l, "treasury", 1, 1, &snap, 100 * ONE),
            Err(Error::AlreadyRewarded(1))
        );
    }

    #[test]
    fn dust_stays_in_the_treasury() {
        let (mut l, mut r) = treasury(100);
        // Reward 10 split 1:1:1 is 3 each; 1 stays.
        let snap = [e("a", 0, 0, 1), e("b", 0, 0, 1), e("c", 0, 0, 1)];
        let paid = r.distribute(&mut l, "treasury", 1, 0, &snap, 10).unwrap();
        assert!(paid.iter().all(|(_, s)| *s == 3));
        assert_eq!(l.ft_balance_of("treasury"), 91);
    }

    #[test]
    fn splitting_a_stake_earns_the_same() {
        let (mut l1, mut r1) = treasury(1000 * ONE);
        let (mut l2, mut r2) = treasury(1000 * ONE);
        let one = [e("whale", 0, 3, 100 * ONE), e("x", 0, 3, 100 * ONE)];
        let split = [
            e("whale1", 0, 3, 50 * ONE),
            e("whale2", 0, 3, 50 * ONE),
            e("x", 0, 3, 100 * ONE),
        ];
        r1.distribute(&mut l1, "treasury", 1, 3, &one, 100 * ONE).unwrap();
        r2.distribute(&mut l2, "treasury", 1, 3, &split, 100 * ONE).unwrap();
        assert_eq!(
            l1.ft_balance_of("whale"),
            l2.ft_balance_of("whale1") + l2.ft_balance_of("whale2")
        );
    }

    #[test]
    fn leaderboard_accumulates_over_days() {
        let (mut l, mut r) = treasury(1000 * ONE);
        r.distribute(&mut l, "treasury", 1, 0, &[e("bob", 0, 0, ONE)], 100 * ONE)
            .unwrap();
        r.distribute(
            &mut l,
            "treasury",
            2,
            0,
            &[e("alice", 0, 0, ONE), e("bob", 0, 0, ONE)],
            90 * ONE,
        )
        .unwrap();
        assert_eq!(
            r.leaderboard(),
            vec![("bob".into(), 145 * ONE), ("alice".into(), 45 * ONE)]
        );
    }

    #[test]
    fn zero_reward_pays_nothing() {
        let (mut l, mut r) = treasury(1000);
        assert_eq!(
            r.distribute(&mut l, "treasury", 1, 0, &[e("a", 0, 0, 5)], 0).unwrap(),
            vec![]
        );
    }
}
