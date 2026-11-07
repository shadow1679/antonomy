//! Burn colony action. The colony picks an index into `BURN_MENU_BPS`; it never
//! supplies an amount. The 2% cap is checked at compile time against the menu.

use crate::{ledger::Ledger, Error};

/// 0.10%, 0.25%, 0.50%, 1.00%, 2.00% of the treasury, in basis points.
pub const BURN_MENU_BPS: [u32; 5] = [10, 25, 50, 100, 200];
/// Hard cap: 2% of the treasury.
pub const MAX_BURN_BPS: u32 = 200;
const BPS_DENOM: u128 = 10_000;

const _: () = {
    let mut i = 0;
    while i < BURN_MENU_BPS.len() {
        assert!(BURN_MENU_BPS[i] <= MAX_BURN_BPS);
        i += 1;
    }
};

/// Amount to burn for menu entry `index`, rounded down.
pub fn burn_amount(treasury_balance: u128, index: usize) -> Result<u128, Error> {
    let bps = *BURN_MENU_BPS.get(index).ok_or(Error::BadBurnIndex(index))?;
    Ok(treasury_balance
        .checked_mul(bps as u128)
        .ok_or(Error::Overflow)?
        / BPS_DENOM)
}

/// Burns at most once per burn day, in day order: a day at or before the
/// last burned one is rejected. `last_day` is the contract state.
#[derive(Debug, Clone, Default)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct BurnExecutor {
    last_day: Option<u64>,
}

impl BurnExecutor {
    /// The newest burn day already executed.
    pub fn last_day(&self) -> Option<u64> {
        self.last_day
    }

    /// Execute the colony's decision. Returns the amount burned.
    pub fn execute(
        &mut self,
        ledger: &mut Ledger,
        treasury: &str,
        day: u64,
        index: usize,
    ) -> Result<u128, Error> {
        if self.last_day.is_some_and(|l| day <= l) {
            return Err(Error::AlreadyBurned(day));
        }
        let amount = burn_amount(ledger.ft_balance_of(treasury), index)?;
        if amount > 0 {
            ledger.burn(treasury, amount)?;
        }
        self.last_day = Some(day);
        Ok(amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ONE;

    #[test]
    fn menu_amounts() {
        let t = 1_000_000 * ONE;
        assert_eq!(burn_amount(t, 0).unwrap(), t / 1000);
        assert_eq!(burn_amount(t, 1).unwrap(), t / 400);
        assert_eq!(burn_amount(t, 2).unwrap(), t / 200);
        assert_eq!(burn_amount(t, 3).unwrap(), t / 100);
        assert_eq!(burn_amount(t, 4).unwrap(), t / 50);
    }

    #[test]
    fn index_outside_menu_is_rejected() {
        assert_eq!(burn_amount(1000, 5), Err(Error::BadBurnIndex(5)));
        assert_eq!(
            burn_amount(1000, usize::MAX),
            Err(Error::BadBurnIndex(usize::MAX))
        );
    }

    #[test]
    fn no_entry_exceeds_two_percent() {
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
            for i in 0..BURN_MENU_BPS.len() {
                assert!(burn_amount(t, i).unwrap() <= t / 50, "t={t} i={i}");
            }
        }
    }

    #[test]
    fn huge_treasury_errors_instead_of_wrapping() {
        assert_eq!(burn_amount(u128::MAX, 4), Err(Error::Overflow));
    }

    #[test]
    fn once_per_day_and_supply_falls() {
        let mut l = Ledger::new("treasury", 10_000);
        let mut b = BurnExecutor::default();
        assert_eq!(b.execute(&mut l, "treasury", 1, 4).unwrap(), 200);
        assert_eq!(l.ft_total_supply(), 9_800);
        assert_eq!(
            b.execute(&mut l, "treasury", 1, 4),
            Err(Error::AlreadyBurned(1))
        );
        assert_eq!(b.execute(&mut l, "treasury", 2, 0).unwrap(), 9);
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
        assert_eq!(b.execute(&mut l, "treasury", 1, 0).unwrap(), 0);
        assert_eq!(l.ft_total_supply(), 50);
        assert_eq!(
            b.execute(&mut l, "treasury", 1, 0),
            Err(Error::AlreadyBurned(1))
        );
    }
}
