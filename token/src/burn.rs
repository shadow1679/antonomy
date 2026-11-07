//! The daily pot. The Burn colony picks an index into `POT_MENU_BPS`; it never
//! supplies an amount. The pot is that share of the treasury: its reward part
//! (`REWARD_MENU_BPS`) goes to the Burn stakers on the picked size
//! (`reward::Rewards::distribute`) and the rest is burned. Rewards vary much
//! less than pots (0.08% to 0.16% against 0.10% to 2.00%), so a bigger pot
//! mostly means a bigger burn, and staking on the biggest size doesn't pay
//! much more; the sim also handicaps the bigger pots (`antosim::BURN_HANDICAP`).
//! The 2% cap is checked at compile time against the menu.

use crate::{ledger::Ledger, Error};

/// Daily pot sizes: 0.10%, 0.25%, 0.50%, 1.00%, 2.00% of the treasury, in basis points.
pub const POT_MENU_BPS: [u32; 5] = [10, 25, 50, 100, 200];
/// The reward part of each pot: 0.08%, 0.10%, 0.12%, 0.14%, 0.16% of the treasury.
/// The burn part is the rest: 0.02%, 0.15%, 0.38%, 0.86%, 1.84%.
pub const REWARD_MENU_BPS: [u32; 5] = [8, 10, 12, 14, 16];
/// Hard cap: the pot is at most 2% of the treasury.
pub const MAX_POT_BPS: u32 = 200;
const BPS_DENOM: u128 = 10_000;

const _: () = {
    let mut i = 0;
    while i < POT_MENU_BPS.len() {
        assert!(POT_MENU_BPS[i] <= MAX_POT_BPS);
        assert!(REWARD_MENU_BPS[i] <= POT_MENU_BPS[i]);
        i += 1;
    }
};

/// One day's pot, split. `burn + reward` is the pot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pot {
    pub burn: u128,
    pub reward: u128,
}

fn share(treasury_balance: u128, bps: u32) -> Result<u128, Error> {
    Ok(treasury_balance
        .checked_mul(bps as u128)
        .ok_or(Error::Overflow)?
        / BPS_DENOM)
}

/// Pot for menu entry `index`, each part rounded down from the treasury
/// balance; the burn part is the pot less the reward.
pub fn pot_amounts(treasury_balance: u128, index: usize) -> Result<Pot, Error> {
    let pot_bps = *POT_MENU_BPS.get(index).ok_or(Error::BadBurnIndex(index))?;
    let pot = share(treasury_balance, pot_bps)?;
    let reward = share(treasury_balance, REWARD_MENU_BPS[index])?;
    Ok(Pot {
        burn: pot - reward,
        reward,
    })
}

/// Runs the pot at most once per burn day, in day order: a day at or before
/// the last one is rejected. `last_day` is the contract state.
#[derive(Debug, Clone, Default)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct BurnExecutor {
    last_day: Option<u64>,
}

impl BurnExecutor {
    /// The newest burn day already executed: its pot has been burned and paid.
    pub fn last_day(&self) -> Option<u64> {
        self.last_day
    }

    /// Execute the colony's decision: burn the pot's burn part from the
    /// treasury. The reward part stays in the treasury for
    /// `Rewards::distribute` to pay out; if nobody staked on the picked size
    /// it simply stays there. Returns the day's pot.
    pub fn execute(
        &mut self,
        ledger: &mut Ledger,
        treasury: &str,
        day: u64,
        index: usize,
    ) -> Result<Pot, Error> {
        if self.last_day.is_some_and(|l| day <= l) {
            return Err(Error::AlreadyBurned(day));
        }
        let pot = pot_amounts(ledger.ft_balance_of(treasury), index)?;
        if pot.burn > 0 {
            ledger.burn(treasury, pot.burn)?;
        }
        self.last_day = Some(day);
        Ok(pot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ONE;

    #[test]
    fn menu_amounts() {
        let t = 1_000_000 * ONE;
        let pot = |i| {
            let p = pot_amounts(t, i).unwrap();
            (p.burn + p.reward, p.reward)
        };
        assert_eq!(pot(0), (t / 1000, t * 8 / 10_000));
        assert_eq!(pot(1), (t / 400, t / 1000));
        assert_eq!(pot(2), (t / 200, t * 12 / 10_000));
        assert_eq!(pot(3), (t / 100, t * 14 / 10_000));
        assert_eq!(pot(4), (t / 50, t * 16 / 10_000));
    }

    #[test]
    fn index_outside_menu_is_rejected() {
        assert_eq!(pot_amounts(1000, 5), Err(Error::BadBurnIndex(5)));
        assert_eq!(
            pot_amounts(1000, usize::MAX),
            Err(Error::BadBurnIndex(usize::MAX))
        );
    }

    #[test]
    fn no_pot_exceeds_two_percent() {
        for t in [
            0u128,
            1,
            49,
            50,
            9_999,
            10_000,
            123_456_789,
            u128::MAX / 10_000,
        ] {
            for i in 0..POT_MENU_BPS.len() {
                let p = pot_amounts(t, i).unwrap();
                assert!(p.burn + p.reward <= t / 50, "t={t} i={i}");
            }
        }
    }

    #[test]
    fn huge_treasury_errors_instead_of_wrapping() {
        assert_eq!(pot_amounts(u128::MAX, 4), Err(Error::Overflow));
    }

    #[test]
    fn once_per_day_and_supply_falls_by_the_burn_part() {
        let mut l = Ledger::new("treasury", 10_000);
        let mut b = BurnExecutor::default();
        assert_eq!(
            b.execute(&mut l, "treasury", 1, 4).unwrap(),
            Pot { burn: 184, reward: 16 }
        );
        // The reward part stays in the treasury until it is paid.
        assert_eq!(l.ft_total_supply(), 9_816);
        assert_eq!(l.ft_balance_of("treasury"), 9_816);
        assert_eq!(
            b.execute(&mut l, "treasury", 1, 4),
            Err(Error::AlreadyBurned(1))
        );
        assert_eq!(
            b.execute(&mut l, "treasury", 2, 0).unwrap(),
            Pot { burn: 2, reward: 7 }
        );
        // An earlier day can't be burned once a later one has been.
        assert_eq!(
            b.execute(&mut l, "treasury", 1, 0),
            Err(Error::AlreadyBurned(1))
        );
    }

    #[test]
    fn rounding_to_zero_burns_nothing_but_consumes_the_day() {
        let mut l = Ledger::new("treasury", 50);
        let mut b = BurnExecutor::default();
        assert_eq!(b.execute(&mut l, "treasury", 1, 0).unwrap(), Pot::default());
        assert_eq!(l.ft_total_supply(), 50);
        assert_eq!(
            b.execute(&mut l, "treasury", 1, 0),
            Err(Error::AlreadyBurned(1))
        );
    }
}
