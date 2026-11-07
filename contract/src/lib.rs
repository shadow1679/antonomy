//! $ANTO contract (NEAR testnet). Thin wrapper over `antotoken`: all token,
//! burn and staking rules live there and are tested there. This layer adds
//! account checks, time, pause and JSON views.
//!
//! Forecast markets: allow-listed keepers post the trending list with
//! `post_trending` before staking closes; after that anyone calls
//! `finalize_markets`, which needs a quorum of matching lists and stores the
//! per-outcome median odds. The forecasters themselves don't run on-chain yet:
//! that waits for the drand round lifecycle, like the Burn colony.
//!
//! Rewards: anyone moves play tokens into the pool with `fund_rewards`. When
//! the colony executes the burn (only after staking has closed), 10% of the
//! pool goes to the Burn colony stakers on the chosen index, pro rata to
//! stake. Forecast colonies never pay. Testnet play token only.
//!
//! Known gaps: no `ft_transfer_call` or storage-management (wallets cannot
//! register accounts yet), the whole state is read on every call (fine for a
//! demo, not for many stakers), and `execute_burn` trusts one `colony` account
//! until the sim result is produced on-chain.

use antotoken::{
    burn::BurnExecutor,
    ledger::{Ledger, DECIMALS, SYMBOL},
    market::{Market, MarketPost, Registry},
    reward::Rewards,
    stake::{hash_hex, StakeConfig, Staking},
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
    /// Forecast markets of the round, posted by keepers.
    markets: Registry,
    /// Play-token reward pool for the Burn colony.
    rewards: Rewards,
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

/// One market in a keeper's trending list. `raw_hash` is 64 hex chars.
#[near(serializers = [json])]
pub struct MarketPostView {
    pub market_id: String,
    pub outcomes: Vec<String>,
    pub odds: Vec<u16>,
    pub odds_6h: Vec<u16>,
    pub raw_hash: String,
}

#[near(serializers = [json])]
pub struct MarketView {
    pub colony: u16,
    pub market_id: String,
    pub outcomes: Vec<String>,
    pub odds: Vec<u16>,
    pub odds_6h: Vec<u16>,
    pub odds_hash: String,
    /// (keeper, raw response hash) for the keepers whose list was accepted.
    pub raw_hashes: Vec<(AccountId, String)>,
}

fn parse_hash(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

impl From<MarketPostView> for MarketPost {
    fn from(v: MarketPostView) -> Self {
        let raw_hash = parse_hash(&v.raw_hash)
            .unwrap_or_else(|| env::panic_str("raw_hash must be 64 hex chars"));
        MarketPost {
            market_id: v.market_id,
            outcomes: v.outcomes,
            odds: v.odds,
            odds_6h: v.odds_6h,
            raw_hash,
        }
    }
}

impl From<&MarketPost> for MarketPostView {
    fn from(p: &MarketPost) -> Self {
        MarketPostView {
            market_id: p.market_id.clone(),
            outcomes: p.outcomes.clone(),
            odds: p.odds.clone(),
            odds_6h: p.odds_6h.clone(),
            raw_hash: hash_hex(&p.raw_hash),
        }
    }
}

impl From<&Market> for MarketView {
    fn from(m: &Market) -> Self {
        MarketView {
            colony: m.colony,
            market_id: m.market_id.clone(),
            outcomes: m.outcomes.clone(),
            odds: m.odds.clone(),
            odds_6h: m.odds_6h.clone(),
            odds_hash: hash_hex(&m.odds_hash),
            raw_hashes: m
                .raw_hashes
                .iter()
                .map(|(k, h)| (k.parse().unwrap(), hash_hex(h)))
                .collect(),
        }
    }
}

#[near(serializers = [json])]
pub struct StakeConfigView {
    pub cap_per_wallet: U128,
    pub close_at_ms: u64,
    pub publish_at_ms: u64,
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
    /// Times are block timestamps in milliseconds. Keepers post markets until
    /// `close_at_ms`, the same close as staking. `quorum` must be a strict
    /// majority of `keepers`.
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
        keepers: Vec<AccountId>,
        quorum: u8,
    ) -> Self {
        let staking = ok(Staking::new(StakeConfig {
            cap_per_wallet: cap_per_wallet.0,
            close_at: close_at_ms,
            publish_at: publish_at_ms,
        }));
        let markets = ok(Registry::new(
            keepers.into_iter().map(String::from).collect(),
            quorum,
            close_at_ms,
        ));
        Self {
            ledger: Ledger::new(treasury.as_str(), total_supply.0),
            burn: BurnExecutor::default(),
            staking,
            markets,
            rewards: Rewards::default(),
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

    pub fn stake_config(&self) -> StakeConfigView {
        let c = self.staking.config();
        StakeConfigView {
            cap_per_wallet: U128(c.cap_per_wallet),
            close_at_ms: c.close_at,
            publish_at_ms: c.publish_at,
        }
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

    /// Raw stake per option. The reward pot is split by raw stake, so this is
    /// what a bot needs to estimate its share while staking is open.
    pub fn stake_totals(&self, colony: u16, n_options: u8) -> Vec<U128> {
        self.staking
            .totals(colony, n_options as usize)
            .into_iter()
            .map(U128)
            .collect()
    }

    /// One wallet's entries as (colony, option, amount), readable while open.
    pub fn stakes_of(&self, account_id: AccountId) -> Vec<(u16, u8, U128)> {
        self.staking
            .stakes_of(account_id.as_str())
            .into_iter()
            .map(|(c, o, v)| (c, o, U128(v)))
            .collect()
    }

    pub fn stake_weights(&self, colony: u16, n_options: u8) -> Vec<U128> {
        self.staking
            .weights(colony, n_options as usize)
            .into_iter()
            .map(U128)
            .collect()
    }

    // ---- forecast markets ----

    /// Keeper only: post or replace this keeper's trending list for the round.
    pub fn post_trending(&mut self, markets: Vec<MarketPostView>) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        let ids: Vec<String> = markets.iter().map(|m| m.market_id.clone()).collect();
        let list = markets.into_iter().map(MarketPost::from).collect();
        ok(self
            .markets
            .post(env::block_timestamp_ms(), who.as_str(), list));
        env::log_str(&format!("EVENT post_trending {who} markets={ids:?}"));
    }

    /// Permissionless once posting has closed: accept the quorum list and
    /// store the median odds. Panics with `NoQuorum` if keepers disagree.
    pub fn finalize_markets(&mut self) -> Vec<MarketView> {
        let ms: Vec<MarketView> = ok(self.markets.finalize(env::block_timestamp_ms()))
            .iter()
            .map(MarketView::from)
            .collect();
        for m in &ms {
            env::log_str(&format!(
                "EVENT market colony={} id={} odds={:?} odds_6h={:?} odds_hash={}",
                m.colony, m.market_id, m.odds, m.odds_6h, m.odds_hash
            ));
        }
        ms
    }

    /// Accepted markets, or null before `finalize_markets`.
    pub fn forecast_markets(&self) -> Option<Vec<MarketView>> {
        self.markets
            .markets()
            .map(|ms| ms.iter().map(MarketView::from).collect())
    }

    pub fn keeper_post(&self, account_id: AccountId) -> Option<Vec<MarketPostView>> {
        self.markets
            .post_of(account_id.as_str())
            .map(|l| l.iter().map(MarketPostView::from).collect())
    }

    /// (keepers, quorum)
    pub fn keepers(&self) -> (Vec<AccountId>, u8) {
        (
            self.markets.keepers().map(|k| k.parse().unwrap()).collect(),
            self.markets.quorum(),
        )
    }

    // ---- burn ----

    /// The colony picks `index` in the burn menu; the amount comes from the menu.
    /// Needs staking to have closed, and pays the round's rewards to the Burn
    /// colony stakers on `index`.
    pub fn execute_burn(&mut self, round: u64, index: u8) -> U128 {
        require!(!self.paused, "paused");
        require!(
            env::predecessor_account_id() == self.colony,
            "only the colony account may execute a burn"
        );
        let snap = ok(self.staking.snapshot(env::block_timestamp_ms()));
        let burned = ok(self.burn.execute(
            &mut self.ledger,
            self.treasury.as_str(),
            round,
            index as usize,
        ));
        env::log_str(&format!(
            "EVENT burn round={round} index={index} amount={burned}"
        ));
        let paid = ok(self
            .rewards
            .distribute(&mut self.ledger, round, index, &snap.entries));
        for (who, amount) in paid {
            env::log_str(&format!("EVENT reward round={round} {who} amount={amount}"));
        }
        U128(burned)
    }

    // ---- rewards ----

    /// Move `amount` of the caller's tokens into the reward pool.
    pub fn fund_rewards(&mut self, amount: U128) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        ok(self.rewards.fund(&mut self.ledger, who.as_str(), amount.0));
        env::log_str(&format!("EVENT fund_rewards {who} amount={}", amount.0));
    }

    pub fn reward_pool(&self) -> U128 {
        U128(self.rewards.pool(&self.ledger))
    }

    pub fn rewards_earned(&self, account_id: AccountId) -> U128 {
        U128(self.rewards.earned_by(account_id.as_str()))
    }

    /// (account, lifetime reward), highest first.
    pub fn reward_leaderboard(&self) -> Vec<(AccountId, U128)> {
        self.rewards
            .leaderboard()
            .into_iter()
            .map(|(a, e)| (a.parse().unwrap(), U128(e)))
            .collect()
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
            vec![acct("k1.test"), acct("k2.test"), acct("k3.test")],
            2,
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
        assert_eq!(c.stake_totals(0, 3)[2].0, 25 * ONE);
        let mine = c.stakes_of(acct("alice.test"));
        assert_eq!(mine.len(), 1);
        assert_eq!((mine[0].0, mine[0].1, mine[0].2 .0), (0, 2, 25 * ONE));
        let cfg = c.stake_config();
        assert_eq!((cfg.cap_per_wallet.0, cfg.close_at_ms), (100 * ONE, 1_000));

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
        testing_env!(ctx("colony.test", 1_000).build());
        let burned = c.execute_burn(1, 4).0;
        assert_eq!(burned, treasury_before / 50);
        assert_eq!(c.ft_total_supply().0, 1_000_000 * ONE - burned);
    }

    #[test]
    #[should_panic(expected = "BadBurnIndex")]
    fn burn_index_outside_menu_panics() {
        let mut c = fresh();
        testing_env!(ctx("colony.test", 1_000).build());
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
        testing_env!(ctx("colony.test", 1_000).build());
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

    #[test]
    #[should_panic(expected = "StakingStillOpen")]
    fn burn_waits_for_staking_to_close() {
        let mut c = fresh();
        testing_env!(ctx("colony.test", 999).build());
        c.execute_burn(1, 0);
    }

    fn give(c: &mut Contract, to: &str, amount: u128) {
        testing_env!(ctx("treasury.test", 0)
            .attached_deposit(near_sdk::NearToken::from_yoctonear(1))
            .build());
        c.ft_transfer(acct(to), U128(amount), None);
    }

    #[test]
    fn burn_pays_rewards_to_burn_stakers_on_the_winner() {
        let mut c = fresh();
        give(&mut c, "bot-follower.test", 100 * ONE);
        give(&mut c, "bot-contrarian.test", 100 * ONE);
        testing_env!(ctx("treasury.test", 0).build());
        c.fund_rewards(U128(1_000 * ONE));
        assert_eq!(c.reward_pool().0, 1_000 * ONE);

        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 2, U128(30 * ONE));
        c.stake(1, 2, U128(50 * ONE)); // forecast colony: never paid
        testing_env!(ctx("bot-follower.test", 10).build());
        c.stake(0, 2, U128(10 * ONE));
        testing_env!(ctx("bot-contrarian.test", 10).build());
        c.stake(0, 4, U128(10 * ONE));

        testing_env!(ctx("colony.test", 1_000).build());
        c.execute_burn(1, 2);
        // Pot is 100: alice 30/40, follower 10/40.
        assert_eq!(c.rewards_earned(acct("alice.test")).0, 75 * ONE);
        assert_eq!(c.rewards_earned(acct("bot-follower.test")).0, 25 * ONE);
        assert_eq!(c.rewards_earned(acct("bot-contrarian.test")).0, 0);
        assert_eq!(c.reward_pool().0, 900 * ONE);
        assert_eq!(c.ft_balance_of(acct("bot-follower.test")).0, 115 * ONE);
        let board = c.reward_leaderboard();
        assert_eq!(board[0], (acct("alice.test"), U128(75 * ONE)));
        assert_eq!(board.len(), 2);
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn fund_rewards_blocked_while_paused() {
        let mut c = fresh();
        testing_env!(ctx("guardian.test", 0).build());
        c.set_paused(true);
        testing_env!(ctx("treasury.test", 0).build());
        c.fund_rewards(U128(ONE));
    }

    fn market(odds: Vec<u16>) -> MarketPostView {
        MarketPostView {
            market_id: "12345".into(),
            outcomes: vec!["Yes".into(), "No".into()],
            odds_6h: odds.clone(),
            odds,
            raw_hash: "ab".repeat(32),
        }
    }

    #[test]
    fn keepers_post_and_median_is_stored() {
        let mut c = fresh();
        for (k, odds) in [
            ("k1.test", vec![6000, 4000]),
            ("k2.test", vec![6400, 3600]),
            ("k3.test", vec![6200, 3700]),
        ] {
            testing_env!(ctx(k, 10).build());
            c.post_trending(vec![market(odds)]);
        }
        assert_eq!(
            c.keeper_post(acct("k2.test")).unwrap()[0].odds,
            vec![6400, 3600]
        );
        assert!(c.forecast_markets().is_none());

        testing_env!(ctx("anyone.test", 1_000).build());
        let ms = c.finalize_markets();
        assert_eq!(ms[0].odds, vec![6200, 3700]);
        assert_eq!(ms[0].colony, 1);
        assert_eq!(ms[0].odds_hash.len(), 64);
        assert_eq!(c.forecast_markets().unwrap()[0].raw_hashes.len(), 3);
    }

    #[test]
    #[should_panic(expected = "NotKeeper")]
    fn only_keepers_post() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 10).build());
        c.post_trending(vec![market(vec![6000, 4000])]);
    }

    #[test]
    #[should_panic(expected = "NoQuorum")]
    fn one_keeper_is_not_a_quorum() {
        let mut c = fresh();
        testing_env!(ctx("k1.test", 10).build());
        c.post_trending(vec![market(vec![6000, 4000])]);
        testing_env!(ctx("anyone.test", 1_000).build());
        c.finalize_markets();
    }

    #[test]
    #[should_panic(expected = "raw_hash must be 64 hex chars")]
    fn raw_hash_must_be_hex() {
        let mut c = fresh();
        testing_env!(ctx("k1.test", 10).build());
        let mut m = market(vec![6000, 4000]);
        m.raw_hash = "zz".repeat(32);
        c.post_trending(vec![m]);
    }

    #[test]
    #[should_panic(expected = "PostingClosed")]
    fn posting_closes_with_staking() {
        let mut c = fresh();
        testing_env!(ctx("k1.test", 1_000).build());
        c.post_trending(vec![market(vec![6000, 4000])]);
    }
}
