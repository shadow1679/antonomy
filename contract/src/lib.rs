//! $ANTO contract (NEAR testnet). Thin wrapper over `antotoken`: all token,
//! burn and staking rules live there and are tested there. This layer adds
//! account checks, time, pause and JSON views.
//!
//! Known gaps: no `ft_transfer_call` or storage-management (wallets cannot
//! register accounts yet), the whole state is read on every call (fine for a
//! demo, not for many stakers), and `execute_burn` trusts one `colony` account
//! until the sim result is produced on-chain.

use antotoken::{
    burn::BurnExecutor,
    ledger::{Ledger, DECIMALS, SYMBOL},
    stake::{StakeConfig, Staking},
    Error,
};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    ledger: Ledger,
    burn: BurnExecutor,
    staking: Staking,
    /// Holds the genesis supply and is the account that gets burned from.
    treasury: AccountId,
    /// Only account allowed to call `execute_burn` (later: the colony run itself).
    colony: AccountId,
    /// Multisig behind a timelock in the real deployment. Can pause, nothing else.
    guardian: AccountId,
    paused: bool,
}

#[near(serializers = [json])]
pub struct SnapshotView {
    pub hash: String,
    /// (account, colony, option, amount)
    pub entries: Vec<(AccountId, u16, u8, U128)>,
}

#[near(serializers = [json])]
pub struct Metadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
}

fn ok<T>(r: Result<T, Error>) -> T {
    r.unwrap_or_else(|e| env::panic_str(&format!("{e:?}")))
}

#[near]
impl Contract {
    /// Times are block timestamps in milliseconds.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        treasury: AccountId,
        colony: AccountId,
        guardian: AccountId,
        total_supply: U128,
        cap_per_wallet: U128,
        close_at_ms: u64,
        publish_at_ms: u64,
    ) -> Self {
        let staking = ok(Staking::new(StakeConfig {
            cap_per_wallet: cap_per_wallet.0,
            close_at: close_at_ms,
            publish_at: publish_at_ms,
        }));
        Self {
            ledger: Ledger::new(treasury.as_str(), total_supply.0),
            burn: BurnExecutor::default(),
            staking,
            treasury,
            colony,
            guardian,
            paused: false,
        }
    }

    // ---- token views and transfer (NEP-141 subset) ----

    pub fn ft_metadata(&self) -> Metadata {
        Metadata {
            spec: "ft-1.0.0".into(),
            name: "Antonomy".into(),
            symbol: SYMBOL.into(),
            decimals: DECIMALS,
        }
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.ledger.ft_total_supply())
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.ledger.ft_balance_of(account_id.as_str()))
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        ok(self
            .ledger
            .ft_transfer(sender.as_str(), receiver_id.as_str(), amount.0));
        if let Some(m) = memo {
            env::log_str(&format!("memo: {m}"));
        }
    }

    // ---- staking ----

    pub fn stake(&mut self, colony: u16, option: u8, amount: U128) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        ok(self.staking.stake(
            &mut self.ledger,
            env::block_timestamp_ms(),
            who.as_str(),
            colony,
            option,
            amount.0,
        ));
        env::log_str(&format!(
            "EVENT stake {who} colony={colony} option={option} amount={}",
            amount.0
        ));
    }

    /// Allowed while paused so a pause can never trap funds.
    pub fn unstake(&mut self, colony: u16, option: u8, amount: U128) {
        let who = env::predecessor_account_id();
        ok(self.staking.unstake(
            &mut self.ledger,
            env::block_timestamp_ms(),
            who.as_str(),
            colony,
            option,
            amount.0,
        ));
        env::log_str(&format!(
            "EVENT unstake {who} colony={colony} option={option} amount={}",
            amount.0
        ));
    }

    /// Permissionless: anyone can mark the round done once the drand round is public.
    pub fn settle(&mut self) {
        ok(self.staking.settle(env::block_timestamp_ms()));
        env::log_str("EVENT settle");
    }

    pub fn staked_by(&self, account_id: AccountId) -> U128 {
        U128(self.staking.staked_by(account_id.as_str()))
    }

    /// Final stake snapshot; panics while staking is still open.
    pub fn stake_snapshot(&self) -> SnapshotView {
        let s = ok(self.staking.snapshot(env::block_timestamp_ms()));
        SnapshotView {
            hash: antotoken::stake::hash_hex(&s.hash),
            entries: s
                .entries
                .into_iter()
                .map(|(a, c, o, v)| (a.parse().unwrap(), c, o, U128(v)))
                .collect(),
        }
    }

    pub fn stake_weights(&self, colony: u16, n_options: u8) -> Vec<U128> {
        self.staking
            .weights(colony, n_options as usize)
            .into_iter()
            .map(U128)
            .collect()
    }

    // ---- burn ----

    /// The colony picks `index` in the burn menu; the amount comes from the menu.
    pub fn execute_burn(&mut self, round: u64, index: u8) -> U128 {
        require!(!self.paused, "paused");
        require!(
            env::predecessor_account_id() == self.colony,
            "only the colony account may execute a burn"
        );
        let burned = ok(self.burn.execute(
            &mut self.ledger,
            self.treasury.as_str(),
            round,
            index as usize,
        ));
        env::log_str(&format!(
            "EVENT burn round={round} index={index} amount={burned}"
        ));
        U128(burned)
    }

    // ---- safety ----

    pub fn set_paused(&mut self, paused: bool) {
        require!(
            env::predecessor_account_id() == self.guardian,
            "only the guardian may pause"
        );
        self.paused = paused;
        env::log_str(&format!("EVENT paused={paused}"));
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const ONE: u128 = antotoken::ledger::ONE;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(who: &str, ms: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(acct(who))
            .block_timestamp(ms * 1_000_000);
        b
    }

    fn fresh() -> Contract {
        testing_env!(ctx("treasury.test", 0).build());
        let mut c = Contract::new(
            acct("treasury.test"),
            acct("colony.test"),
            acct("guardian.test"),
            U128(1_000_000 * ONE),
            U128(100 * ONE),
            1_000,
            2_000,
        );
        testing_env!(ctx("treasury.test", 0)
            .attached_deposit(near_sdk::NearToken::from_yoctonear(1))
            .build());
        c.ft_transfer(acct("alice.test"), U128(500 * ONE), None);
        c
    }

    #[test]
    fn transfer_needs_one_yocto() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 0).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.ft_transfer(acct("bob.test"), U128(1), None)
        }));
        assert!(r.is_err());
    }

    #[test]
    fn stake_snapshot_after_close() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 2, U128(25 * ONE));
        assert_eq!(c.staked_by(acct("alice.test")).0, 25 * ONE);
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 475 * ONE);
        assert_eq!(c.stake_weights(0, 3)[2].0, antotoken::isqrt(25 * ONE));

        testing_env!(ctx("anyone.test", 1_000).build());
        let snap = c.stake_snapshot();
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.hash.len(), 64);
    }

    #[test]
    #[should_panic(expected = "StakingClosed")]
    fn stake_after_close_panics() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 1_000).build());
        c.stake(0, 0, U128(ONE));
    }

    #[test]
    #[should_panic(expected = "only the colony account")]
    fn burn_only_by_colony() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 0).build());
        c.execute_burn(1, 4);
    }

    #[test]
    fn colony_burn_lowers_supply_by_menu_amount() {
        let mut c = fresh();
        let treasury_before = c.ft_balance_of(acct("treasury.test")).0;
        testing_env!(ctx("colony.test", 0).build());
        let burned = c.execute_burn(1, 4).0;
        assert_eq!(burned, treasury_before / 50);
        assert_eq!(c.ft_total_supply().0, 1_000_000 * ONE - burned);
    }

    #[test]
    #[should_panic(expected = "BadBurnIndex")]
    fn burn_index_outside_menu_panics() {
        let mut c = fresh();
        testing_env!(ctx("colony.test", 0).build());
        c.execute_burn(1, 5);
    }

    #[test]
    fn pause_blocks_stake_and_burn_but_not_unstake() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 0, U128(10 * ONE));
        testing_env!(ctx("guardian.test", 10).build());
        c.set_paused(true);
        assert!(c.is_paused());

        testing_env!(ctx("alice.test", 20).build());
        c.unstake(0, 0, U128(10 * ONE));
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 500 * ONE);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.stake(0, 0, U128(ONE))))
                .is_err()
        );
        testing_env!(ctx("colony.test", 20).build());
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.execute_burn(1, 0)))
                .is_err()
        );
    }

    #[test]
    #[should_panic(expected = "only the guardian")]
    fn only_guardian_pauses() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 0).build());
        c.set_paused(true);
    }

    #[test]
    fn settle_then_unstake_after_close() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 0, U128(10 * ONE));
        testing_env!(ctx("alice.test", 1_500).build());
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.unstake(0, 0, U128(ONE))))
                .is_err()
        );
        testing_env!(ctx("anyone.test", 2_000).build());
        c.settle();
        testing_env!(ctx("alice.test", 2_001).build());
        c.unstake(0, 0, U128(10 * ONE));
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 500 * ONE);
    }
}
