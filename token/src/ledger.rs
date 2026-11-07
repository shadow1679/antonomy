//! Fungible token ledger with the NEP-141 view/transfer shape (ft_total_supply,
//! ft_balance_of, ft_transfer). Storage deposits, callbacks and the 1 yoctoNEAR
//! rule belong to the contract wrapper.

use crate::Error;
use std::collections::BTreeMap;

pub type AccountId = String;

pub const SYMBOL: &str = "ANTO";
/// 24 decimals, the NEAR convention.
pub const DECIMALS: u8 = 24;
pub const ONE: u128 = 1_000_000_000_000_000_000_000_000;

#[derive(Debug, Clone, Default)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Ledger {
    balances: BTreeMap<AccountId, u128>,
    total_supply: u128,
}

impl Ledger {
    /// Fixed-supply genesis: everything minted once to `owner`. There is no
    /// mint after this, so supply can only fall (burn).
    pub fn new(owner: &str, supply: u128) -> Ledger {
        let mut balances = BTreeMap::new();
        balances.insert(owner.to_string(), supply);
        Ledger {
            balances,
            total_supply: supply,
        }
    }

    pub fn ft_total_supply(&self) -> u128 {
        self.total_supply
    }

    pub fn ft_balance_of(&self, who: &str) -> u128 {
        self.balances.get(who).copied().unwrap_or(0)
    }

    pub fn ft_transfer(&mut self, from: &str, to: &str, amount: u128) -> Result<(), Error> {
        if amount == 0 {
            return Err(Error::ZeroAmount);
        }
        let have = self.ft_balance_of(from);
        if have < amount {
            return Err(Error::InsufficientBalance { have, need: amount });
        }
        // Check the credit first so a failure leaves the ledger untouched.
        let to_new = if from == to {
            have
        } else {
            self.ft_balance_of(to)
                .checked_add(amount)
                .ok_or(Error::Overflow)?
        };
        if from != to {
            self.balances.insert(from.to_string(), have - amount);
            self.balances.insert(to.to_string(), to_new);
        }
        Ok(())
    }

    /// Destroy tokens from `from`, lowering total supply.
    pub fn burn(&mut self, from: &str, amount: u128) -> Result<(), Error> {
        if amount == 0 {
            return Err(Error::ZeroAmount);
        }
        let have = self.ft_balance_of(from);
        if have < amount {
            return Err(Error::InsufficientBalance { have, need: amount });
        }
        self.balances.insert(from.to_string(), have - amount);
        self.total_supply -= amount;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_moves_balance_and_keeps_supply() {
        let mut l = Ledger::new("treasury", 1000 * ONE);
        l.ft_transfer("treasury", "alice", 40 * ONE).unwrap();
        assert_eq!(l.ft_balance_of("alice"), 40 * ONE);
        assert_eq!(l.ft_balance_of("treasury"), 960 * ONE);
        assert_eq!(l.ft_total_supply(), 1000 * ONE);
    }

    #[test]
    fn transfer_rejects_overdraft_and_zero_without_changes() {
        let mut l = Ledger::new("a", 10);
        assert_eq!(
            l.ft_transfer("a", "b", 11),
            Err(Error::InsufficientBalance { have: 10, need: 11 })
        );
        assert_eq!(l.ft_transfer("a", "b", 0), Err(Error::ZeroAmount));
        assert_eq!(l.ft_balance_of("a"), 10);
        assert_eq!(l.ft_balance_of("b"), 0);
    }

    #[test]
    fn self_transfer_is_a_noop() {
        let mut l = Ledger::new("a", 10);
        l.ft_transfer("a", "a", 10).unwrap();
        assert_eq!(l.ft_balance_of("a"), 10);
    }

    #[test]
    fn burn_lowers_supply() {
        let mut l = Ledger::new("t", 100);
        l.burn("t", 30).unwrap();
        assert_eq!(l.ft_total_supply(), 70);
        assert_eq!(l.ft_balance_of("t"), 70);
        assert!(l.burn("t", 71).is_err());
    }
}
