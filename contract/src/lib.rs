//! $ANTO contract (NEAR testnet). Thin wrapper over `antotoken`: all token,
//! burn and staking rules live there and are tested there. This layer adds
//! account checks, time, pause and JSON views.
//!
//! Forecast markets: allow-listed keepers post the trending list with
//! `post_trending` before staking closes; after that anyone calls
//! `finalize_markets`, which needs a quorum of matching lists and stores the
//! per-outcome median odds. From the round's publish time anyone calls
//! `crank_round`, one forecaster colony per call, and the colonies run on-chain.
//!
//! Burn days (`antotoken::day`): Burn colony stakes follow the UTC day, not
//! the round. They freeze at 12:00 UTC into that day's snapshot (a stake made
//! later counts from the next day), can't be withdrawn from 12:00 to 24:00
//! while the colony runs, and `execute_burn(day, index)` is allowed from that
//! day's 24:00, once per day and in day order. `burn_schedule` and
//! `burn_snapshot` are the views.
//!
//! Recruit the swarm (`antotoken::request`, `antotoken::agents`): anyone pays
//! the request fee with `request_forecast(market_id)`, naming a Polymarket slug.
//! $ANTO lives in this contract, so the fee is debited directly; a separate
//! `ft_transfer_call` would only add a self-call. Keepers post the market's
//! odds with `post_request_odds`, anyone calls `finalize_request_odds` (no
//! quorum skips the request and refunds the fee), registered forecaster agents
//! (`register_agent`, a refundable deposit) post their own odds with
//! `post_forecast`, and anyone calls `crank_request` five times, one colony per
//! call, for the crank bounty. The first crank draws the seed (see Seeds).
//! The last pays the fee out.
//! Agents may also post on the round's trending markets once they are
//! finalized, until the round's publish time; those posts are frozen when
//! the round lifecycle lands.
//!
//! Rewards: anyone moves play tokens into the pool with `fund_rewards`. When
//! the colony executes a day's burn, 10% of the pool goes to the Burn colony
//! stakers on the chosen index in that day's snapshot, pro rata to stake.
//! Forecast colonies never pay. Testnet play token only.
//!
//! Seeds (`drand`): every seed commits to a drand quicknet round fixed by
//! time, the first one published after the inputs close: after the round's
//! `publish_at`, after a request's agents' window, after a burn day's 12:00
//! UTC. The call that draws the seed passes that round's signature as
//! `drand_signature`; the contract checks it with NEAR's BLS12-381 host
//! functions and hashes drand's randomness into the seed. The views name the
//! round (`drand_round`), and the seed events log it with the randomness.
//!
//! Token standards: NEP-141 with `ft_transfer_call` (the receiver's
//! `ft_on_transfer` returns what it didn't use, and `ft_resolve_transfer`
//! refunds that, capped at what the receiver still holds) and NEP-145 storage
//! management. Storage is free: the contract pays for every account's entry
//! from its own NEAR, so every account counts as registered with a zero
//! storage balance, `storage_deposit` refunds whatever is attached and
//! `storage_balance_bounds` is 0 to 0. Wallets that check registration before
//! a transfer see an account that needs nothing. `storage_unregister` drops an
//! empty entry; with `force` it burns the balance first.
//!
//! Known gap: the whole state is read on every call (fine for a demo, not
//! for many stakers).

use antotoken::{
    agents::{AgentSnapshot, Agents},
    burn::BurnExecutor,
    burnrun::BurnRun,
    day,
    ledger::{Ledger, DECIMALS, SYMBOL},
    market::{Market, MarketPost, Registry},
    request::{Phase, Request, RequestConfig, RequestStakes, Requests},
    reward::Rewards,
    round::{RoundRun, CRANKS_PER_MARKET},
    stake::{hash_hex, Snapshot, StakeConfig, Staking},
    Error,
};
use antotoken::antosim::{Colony, BURN_TICKS};

mod drand;
use std::collections::BTreeSet;
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, PanicOnDefault,
    Promise, PromiseOrValue,
};

/// Gas kept back from `ft_transfer_call`'s prepaid gas for the call itself
/// and `ft_resolve_transfer`; the receiver gets the rest. The resolve reads
/// the whole state, so it gets more than the standard 5 TGas.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(40);
/// A receiver's `ft_on_transfer` answer is a JSON string of a u128: at most
/// 41 bytes. Anything longer counts as a refund of everything.
const MAX_RESOLVE_RESULT: usize = 64;

#[ext_contract(ext_ft_receiver)]
pub trait FungibleTokenReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String)
        -> PromiseOrValue<U128>;
}

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
    /// Requested forecasts (Recruit the swarm).
    requests: Requests,
    /// Registered forecaster agents and their open posts.
    agents: Agents,
    /// Holds the genesis supply and is the account that gets burned from.
    treasury: AccountId,
    /// Multisig behind a timelock in the real deployment. Can pause, nothing else.
    guardian: AccountId,
    paused: bool,
    /// How later rounds are scheduled (the first one is set at init).
    round_cfg: RoundConfig,
    /// Round counter; round 0 is the one the contract was initialised with.
    round: u64,
    /// The round's forecast colonies once cranking has begun.
    round_run: Option<RoundRun>,
    /// The newest finished round and the markets it ran, kept after
    /// `start_round` so a page can still show its result.
    last_round: Option<(RoundRun, Vec<Market>)>,
    /// The newest Burn colony run. Its colony bytes live under `BURN_COLONY_KEY`.
    burn_run: Option<BurnRun>,
    /// Accounts that already took their play tokens from the faucet.
    claimed: BTreeSet<AccountId>,
    /// Play tokens `claim_play_tokens` pays out of the treasury.
    faucet_amount: u128,
}

/// Where the Burn colony's bytes are kept, apart from the contract state so
/// a call that only moves tokens doesn't load them.
const BURN_COLONY_KEY: &[u8] = b"burn-colony";
/// A round whose markets were posted but never cranked is abandoned this long
/// after its publish time, so a stuck round can't block the next one.
const ROUND_GRACE_MS: u64 = day::DAY_MS;

/// How long later rounds stay open: stake window, then the agents' window
/// until the round's publish time, which fixes its drand round.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
pub struct RoundConfig {
    pub stake_ms: u64,
    pub gap_ms: u64,
}

#[near(serializers = [json])]
pub struct SnapshotView {
    pub hash: String,
    /// (account, colony, option, amount)
    pub entries: Vec<(AccountId, u16, u8, U128)>,
}

impl From<Snapshot> for SnapshotView {
    fn from(s: Snapshot) -> Self {
        SnapshotView {
            hash: hash_hex(&s.hash),
            entries: s
                .entries
                .into_iter()
                .map(|(a, c, o, v)| (a.parse().unwrap(), c, o, U128(v)))
                .collect(),
        }
    }
}

/// Today's burn day (UTC). `phase` is "staking" before 12:00 and "running"
/// until 24:00. `drawn_day` is the newest day whose stakes have frozen.
#[near(serializers = [json])]
pub struct BurnScheduleView {
    pub day: u64,
    pub phase: String,
    pub run_at_ms: u64,
    pub end_at_ms: u64,
    pub drawn_day: Option<u64>,
    /// The drand round `drawn_day`'s seed commits to: the first one
    /// published after its 12:00 UTC. The call that starts its run passes
    /// this round's signature.
    pub drand_round: Option<u64>,
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

/// Fee, its split (basis points; the burn gets the rest), the two posting
/// windows and the agent deposit. Sample values until the split is decided.
#[near(serializers = [json])]
pub struct RequestConfigView {
    pub fee: U128,
    pub keeper_bps: u16,
    pub agent_bps: u16,
    pub crank_bps: u16,
    pub odds_window_ms: u64,
    pub forecast_window_ms: u64,
    pub agent_deposit: U128,
    /// Paid to each of the five crank calls.
    pub crank_bounty: U128,
}

impl From<RequestConfig> for RequestConfigView {
    fn from(c: RequestConfig) -> Self {
        RequestConfigView {
            fee: U128(c.fee),
            keeper_bps: c.keeper_bps,
            agent_bps: c.agent_bps,
            crank_bps: c.crank_bps,
            odds_window_ms: c.odds_window,
            forecast_window_ms: c.forecast_window,
            agent_deposit: U128(c.agent_deposit),
            crank_bounty: U128(c.crank_bounty()),
        }
    }
}

impl From<RequestConfigView> for RequestConfig {
    fn from(v: RequestConfigView) -> Self {
        RequestConfig {
            fee: v.fee.0,
            keeper_bps: v.keeper_bps,
            agent_bps: v.agent_bps,
            crank_bps: v.crank_bps,
            odds_window: v.odds_window_ms,
            forecast_window: v.forecast_window_ms,
            agent_deposit: v.agent_deposit.0,
        }
    }
}

/// Frozen (or, for an open colony, would-be) agent-odds snapshot.
#[near(serializers = [json])]
pub struct AgentSnapshotView {
    /// Per-outcome lower median; all zeros (an even map) with no posts.
    pub odds: Vec<u16>,
    /// 64 hex chars; all zeros with no posts.
    pub hash: String,
    pub posts: Vec<(AccountId, Vec<u16>)>,
}

impl From<&AgentSnapshot> for AgentSnapshotView {
    fn from(s: &AgentSnapshot) -> Self {
        AgentSnapshotView {
            odds: s.odds.clone(),
            hash: hash_hex(&s.hash),
            posts: s
                .posts
                .iter()
                .map(|(a, o)| (a.parse().unwrap(), o.clone()))
                .collect(),
        }
    }
}

/// One requested forecast. Everything a page or agent needs to re-run it:
/// seed, odds, agent median and hashes. Amounts in yocto.
#[near(serializers = [json])]
pub struct RequestView {
    pub id: u32,
    pub colony: u16,
    pub requester: AccountId,
    pub market_id: String,
    pub fee: U128,
    /// "odds", "forecasting", "running", "done" or "skipped".
    pub phase: String,
    pub created_at_ms: u64,
    pub odds_by_ms: u64,
    pub forecast_by_ms: Option<u64>,
    /// The drand round the seed commits to, the first one published after
    /// `forecast_by_ms`; the first `crank_request` passes its signature.
    pub drand_round: Option<u64>,
    /// Keepers who have posted while the odds are open.
    pub keepers_posted: Vec<AccountId>,
    pub market: Option<MarketView>,
    pub agents: Option<AgentSnapshotView>,
    /// The request colony's stakes, frozen at the first crank: Community's
    /// weights and the stake hash every colony commits. While the agents'
    /// window is open, read `stake_totals(colony, n)` instead.
    pub stakes: Option<RequestStakesView>,
    pub seed: Option<String>,
    /// Result hash of each colony cranked so far, in forecaster order.
    pub colony_hashes: Vec<String>,
    pub crankers: Vec<AccountId>,
    pub swarm: Option<Vec<u16>>,
    pub market_hash: Option<String>,
    pub paid_keepers: Vec<(AccountId, U128)>,
    pub paid_agents: Vec<(AccountId, U128)>,
    pub paid_cranks: Vec<(AccountId, U128)>,
    pub burned: U128,
}

#[near(serializers = [json])]
pub struct RequestStakesView {
    pub hash: String,
    /// Milli sqrt-tokens per outcome, Community's food.
    pub weights: Vec<u32>,
    /// (account, colony, option, amount), as in `stake_snapshot`.
    pub entries: Vec<(AccountId, u16, u8, U128)>,
}

impl From<&RequestStakes> for RequestStakesView {
    fn from(s: &RequestStakes) -> Self {
        RequestStakesView {
            hash: hash_hex(&s.hash),
            weights: s.weights.clone(),
            entries: s
                .entries
                .iter()
                .map(|(a, c, o, v)| (a.parse().unwrap(), *c, *o, U128(*v)))
                .collect(),
        }
    }
}

fn phase_name(p: Phase) -> &'static str {
    match p {
        Phase::Odds => "odds",
        Phase::Forecasting => "forecasting",
        Phase::Running => "running",
        Phase::Done => "done",
        Phase::Skipped => "skipped",
    }
}

fn paid(v: &[(String, u128)]) -> Vec<(AccountId, U128)> {
    v.iter()
        .map(|(a, x)| (a.parse().unwrap(), U128(*x)))
        .collect()
}

impl From<&Request> for RequestView {
    fn from(r: &Request) -> Self {
        RequestView {
            id: r.id,
            colony: r.colony,
            requester: r.requester.parse().unwrap(),
            market_id: r.market_id.clone(),
            fee: U128(r.fee),
            phase: phase_name(r.phase).into(),
            created_at_ms: r.created_at,
            odds_by_ms: r.odds_by,
            forecast_by_ms: r.forecast_by,
            drand_round: r.forecast_by.map(drand::round_after),
            keepers_posted: r.keeper_posts.keys().map(|k| k.parse().unwrap()).collect(),
            market: r.market.as_ref().map(MarketView::from),
            agents: r.agents.as_ref().map(AgentSnapshotView::from),
            stakes: r.stakes.as_ref().map(RequestStakesView::from),
            seed: r.seed.as_ref().map(hash_hex),
            colony_hashes: r.runs.iter().map(|c| hash_hex(&c.hash)).collect(),
            crankers: r.runs.iter().map(|c| c.cranker.parse().unwrap()).collect(),
            swarm: r.swarm.clone(),
            market_hash: r.market_hash.as_ref().map(hash_hex),
            paid_keepers: paid(&r.payouts.keepers),
            paid_agents: paid(&r.payouts.agents),
            paid_cranks: paid(&r.payouts.cranks),
            burned: U128(r.payouts.burned),
        }
    }
}

/// The Burn colony's run for one day. `winner_option`, `result_hash`,
/// `scores` and `perm` appear once the last tick is in (24:00 UTC).
#[near(serializers = [json])]
pub struct BurnRunView {
    pub day: u64,
    pub t: u32,
    pub ticks: u32,
    /// sha256(tag, drand randomness, day, contract account).
    pub seed: String,
    /// The drand round the seed came from.
    pub drand_round: u64,
    pub stake_hash: String,
    pub done: bool,
    pub winner_option: Option<u8>,
    pub result_hash: Option<String>,
    pub scores: Option<Vec<u32>>,
    pub perm: Option<Vec<u8>>,
}

impl From<&BurnRun> for BurnRunView {
    fn from(r: &BurnRun) -> Self {
        let res = r.result.as_ref();
        BurnRunView {
            day: r.day,
            t: r.t,
            ticks: BURN_TICKS,
            seed: hash_hex(&r.seed),
            drand_round: drand::round_after(day::run_at(r.day)),
            stake_hash: hash_hex(&r.stake_hash),
            done: r.is_done(),
            winner_option: res.map(|x| x.winner_option),
            result_hash: res.map(|x| hash_hex(&x.hash)),
            scores: res.map(|x| x.scores.clone()),
            perm: res.map(|x| x.perm.clone()),
        }
    }
}

/// One market's run in the round: inputs frozen at the first crank and the
/// result of each colony so far.
#[near(serializers = [json])]
pub struct RoundMarketRunView {
    pub colony: u16,
    /// Stake weights in milli sqrt-tokens per outcome, the Community colony's food.
    pub weights: Vec<u32>,
    pub agents: AgentSnapshotView,
    pub colony_hashes: Vec<String>,
    pub crankers: Vec<AccountId>,
    pub swarm: Option<Vec<u16>>,
    pub market_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct RoundRunView {
    pub round: u64,
    pub seed: String,
    pub stake_hash: String,
    pub markets: Vec<RoundMarketRunView>,
    pub done: bool,
}

impl From<&RoundRun> for RoundRunView {
    fn from(r: &RoundRun) -> Self {
        RoundRunView {
            round: r.round,
            seed: hash_hex(&r.seed),
            stake_hash: hash_hex(&r.stake_hash),
            done: r.done,
            markets: r
                .markets
                .iter()
                .map(|m| RoundMarketRunView {
                    colony: m.colony,
                    weights: m.weights.clone(),
                    agents: AgentSnapshotView::from(&m.agents),
                    colony_hashes: m.runs.iter().map(|c| hash_hex(&c.hash)).collect(),
                    crankers: m.runs.iter().map(|c| c.cranker.parse().unwrap()).collect(),
                    swarm: m.swarm.clone(),
                    market_hash: m.market_hash.as_ref().map(hash_hex),
                })
                .collect(),
        }
    }
}

#[near(serializers = [json])]
pub struct LastRoundView {
    pub markets: Vec<MarketView>,
    pub run: RoundRunView,
}

/// Where the current round stands. `phase`: "posting" (keepers post and
/// stakes are open), "agents" (staking closed, agents post), "ready" (publish
/// time passed, waiting for cranks), "running", "done" or "skipped" (no
/// quorum by the publish time; `start_round` moves on).
#[near(serializers = [json])]
pub struct RoundView {
    pub round: u64,
    pub phase: String,
    pub close_at_ms: u64,
    pub publish_at_ms: u64,
    /// The drand round the seed commits to, the first one published after
    /// `publish_at_ms`; the first `crank_round` passes its signature.
    pub drand_round: u64,
    pub markets: Option<Vec<MarketView>>,
    pub run: Option<RoundRunView>,
}

#[near(serializers = [json])]
pub struct StakeConfigView {
    pub cap_per_wallet: U128,
    pub close_at_ms: u64,
    pub publish_at_ms: u64,
}

/// NEP-145 storage balance. Always zero here: the contract pays for storage.
#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

const NO_STORAGE: StorageBalance = StorageBalance {
    total: U128(0),
    available: U128(0),
};

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
    /// majority of `keepers`, who also post odds for requested markets.
    /// `round_config` times every round after the first. `faucet_amount` is
    /// what each account may claim once from the treasury (play tokens).
    ///
    /// Re-runnable by the contract account itself (`ignore_state`): on the
    /// testnet a redeploy that changes the state layout starts afresh.
    #[init(ignore_state)]
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        treasury: AccountId,
        guardian: AccountId,
        total_supply: U128,
        cap_per_wallet: U128,
        close_at_ms: u64,
        publish_at_ms: u64,
        keepers: Vec<AccountId>,
        quorum: u8,
        request_config: RequestConfigView,
        round_config: RoundConfig,
        faucet_amount: U128,
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
        env::storage_remove(BURN_COLONY_KEY);
        Self {
            ledger: Ledger::new(treasury.as_str(), total_supply.0),
            burn: BurnExecutor::default(),
            staking,
            markets,
            rewards: Rewards::default(),
            requests: ok(Requests::new(request_config.into())),
            agents: Agents::default(),
            treasury,
            guardian,
            paused: false,
            round_cfg: round_config,
            round: 0,
            round_run: None,
            last_round: None,
            burn_run: None,
            claimed: BTreeSet::new(),
            faucet_amount: faucet_amount.0,
        }
    }

    /// One-time play tokens for an account, paid from the treasury, so a
    /// wallet can try staking, requesting and posting. Testnet only.
    pub fn claim_play_tokens(&mut self) -> U128 {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        require!(self.claimed.insert(who.clone()), "already claimed");
        ok(self
            .ledger
            .ft_transfer(self.treasury.as_str(), who.as_str(), self.faucet_amount));
        env::log_str(&format!(
            "EVENT claim {who} amount={}",
            self.faucet_amount
        ));
        U128(self.faucet_amount)
    }

    pub fn has_claimed(&self, account_id: AccountId) -> bool {
        self.claimed.contains(&account_id)
    }

    pub fn faucet_amount(&self) -> U128 {
        U128(self.faucet_amount)
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

    /// NEP-141: move `amount` to `receiver_id`, then call its `ft_on_transfer`.
    /// Whatever it reports unused comes back to the sender in
    /// `ft_resolve_transfer`, which returns the amount actually used.
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        require!(
            env::prepaid_gas() > GAS_FOR_FT_TRANSFER_CALL,
            "more gas is required"
        );
        let sender = env::predecessor_account_id();
        require!(sender != receiver_id, "sender and receiver must differ");
        ok(self
            .ledger
            .ft_transfer(sender.as_str(), receiver_id.as_str(), amount.0));
        env::log_str(&format!(
            "EVENT ft_transfer_call {sender} -> {receiver_id} amount={}",
            amount.0
        ));
        if let Some(m) = memo {
            env::log_str(&format!("memo: {m}"));
        }
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(env::prepaid_gas().saturating_sub(GAS_FOR_FT_TRANSFER_CALL))
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    /// Callback of `ft_transfer_call`. A failed or unreadable receiver call
    /// refunds everything; otherwise the receiver's unused amount, at most
    /// `amount` and at most what the receiver still holds. Returns the used amount.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = env::promise_result_checked(0, MAX_RESOLVE_RESULT)
            .ok()
            .and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok())
            .map_or(amount.0, |u| u.0.min(amount.0));
        let refund = unused.min(self.ledger.ft_balance_of(receiver_id.as_str()));
        if refund > 0 {
            ok(self
                .ledger
                .ft_transfer(receiver_id.as_str(), sender_id.as_str(), refund));
            env::log_str(&format!(
                "EVENT ft_refund {receiver_id} -> {sender_id} amount={refund}"
            ));
        }
        U128(amount.0 - refund)
    }

    // ---- storage management (NEP-145): free, the contract pays ----

    /// Refunds the whole attached deposit: no account needs one.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = (account_id, registration_only);
        let deposit = env::attached_deposit();
        if !deposit.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(deposit)
                .detach();
        }
        NO_STORAGE
    }

    /// Nothing is ever available to withdraw; asking for more than 0 panics.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        require!(
            amount.is_none_or(|a| a.0 == 0),
            "nothing to withdraw: storage is free"
        );
        NO_STORAGE
    }

    /// Drop the caller's empty token entry. With a balance it panics, unless
    /// `force`, which burns the balance first. Staked tokens sit in the
    /// stake vault and are untouched. The treasury can't unregister.
    /// Returns whether the caller had an entry.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(who != self.treasury, "the treasury can't unregister");
        let have = self.ledger.ft_balance_of(who.as_str());
        if have > 0 {
            require!(
                force.unwrap_or(false),
                "account holds tokens: transfer them out or pass force"
            );
            ok(self.ledger.burn(who.as_str(), have));
            env::log_str(&format!("EVENT ft_burn {who} amount={have} reason=unregister"));
        }
        ok(self.ledger.forget(who.as_str()))
    }

    /// Every account counts as registered, with a zero storage balance.
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let _ = account_id;
        Some(NO_STORAGE)
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(0),
            max: Some(U128(0)),
        }
    }

    // ---- staking ----

    /// Lock `amount` on `option` of `colony`: 0 is the Burn colony, 1 + m
    /// the round's market m, 0x8000 + id requested forecast id (only while
    /// its agents' window is open).
    pub fn stake(&mut self, colony: u16, option: u8, amount: U128) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        ok(if Requests::id_of(colony).is_some() {
            self.requests.stake(
                &mut self.staking,
                &mut self.ledger,
                now,
                who.as_str(),
                colony,
                option,
                amount.0,
            )
        } else {
            self.staking
                .stake(&mut self.ledger, now, who.as_str(), colony, option, amount.0)
        });
        env::log_str(&format!(
            "EVENT stake {who} colony={colony} option={option} amount={}",
            amount.0
        ));
    }

    /// Allowed while paused so a pause can never trap funds. A requested
    /// forecast's stakes are locked from the end of its agents' window until
    /// its last colony has run.
    pub fn unstake(&mut self, colony: u16, option: u8, amount: U128) {
        let who = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        ok(if Requests::id_of(colony).is_some() {
            self.requests.unstake(
                &mut self.staking,
                &mut self.ledger,
                now,
                who.as_str(),
                colony,
                option,
                amount.0,
            )
        } else {
            self.staking
                .unstake(&mut self.ledger, now, who.as_str(), colony, option, amount.0)
        });
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

    /// The round's final stake snapshot (every colony but the Burn colony);
    /// panics while staking is still open.
    pub fn stake_snapshot(&self) -> SnapshotView {
        ok(self.staking.snapshot(env::block_timestamp_ms())).into()
    }

    /// Burn colony stakes frozen at `day`'s 12:00 UTC, the stake input of
    /// that day's colony. Panics before then, and once the day is burned.
    pub fn burn_snapshot(&self, day: u64) -> SnapshotView {
        ok(self.staking.burn_snapshot(day, env::block_timestamp_ms())).into()
    }

    pub fn burn_schedule(&self) -> BurnScheduleView {
        let now = env::block_timestamp_ms();
        let d = now / day::DAY_MS;
        BurnScheduleView {
            day: d,
            phase: if day::running(now) {
                "running"
            } else {
                "staking"
            }
            .into(),
            run_at_ms: day::run_at(d),
            end_at_ms: day::end_at(d),
            drawn_day: day::drawn_day(now),
            drand_round: day::drawn_day(now).map(|d| drand::round_after(day::run_at(d))),
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

    // ---- the round: forecast colonies on-chain ----

    pub fn round_status(&self) -> RoundView {
        let now = env::block_timestamp_ms();
        let cfg = self.staking.config();
        let markets = self.markets.markets();
        let phase = match (&self.round_run, markets) {
            (Some(r), _) if r.done => "done",
            (Some(_), _) => "running",
            (None, _) if now < cfg.close_at => "posting",
            (None, Some(_)) if now < cfg.publish_at => "agents",
            (None, Some(_)) => "ready",
            (None, None) if now < cfg.publish_at => "agents",
            (None, None) => "skipped",
        };
        RoundView {
            round: self.round,
            phase: phase.into(),
            close_at_ms: cfg.close_at,
            publish_at_ms: cfg.publish_at,
            drand_round: drand::round_after(cfg.publish_at),
            markets: markets.map(|ms| ms.iter().map(MarketView::from).collect()),
            run: self.round_run.as_ref().map(RoundRunView::from),
        }
    }

    /// Permissionless from the round's publish time: the first call freezes
    /// the stakes and the agents' posts and draws the seed, and must pass the
    /// signature of `round_status().drand_round`; each call runs one
    /// forecaster colony. The market needs `finalize_markets` first.
    pub fn crank_round(&mut self, drand_signature: Option<String>) -> RoundRunView {
        require!(!self.paused, "paused");
        let now = env::block_timestamp_ms();
        let who = env::predecessor_account_id();
        let cfg = self.staking.config();
        if now < cfg.publish_at {
            ok::<()>(Err(Error::PostingStillOpen));
        }
        let markets: Vec<Market> = self
            .markets
            .markets()
            .unwrap_or_else(|| ok(Err(Error::NotCrankable)))
            .to_vec();
        let mut run = match self.round_run.take() {
            Some(r) => r,
            None => {
                let drand_round = drand::round_after(cfg.publish_at);
                let entropy = drand::entropy(drand_round, drand_signature.as_deref());
                let r = ok(RoundRun::start(
                    self.round,
                    now,
                    entropy,
                    env::current_account_id().as_str(),
                    &markets,
                    &self.staking,
                    &mut self.agents,
                ));
                env::log_str(&format!(
                    "EVENT round_seed round={} seed={} stakes={} drand={drand_round} randomness={}",
                    r.round,
                    hash_hex(&r.seed),
                    hash_hex(&r.stake_hash),
                    hash_hex(&entropy)
                ));
                r
            }
        };
        let c = ok(run.crank(who.as_str(), &markets));
        env::log_str(&format!(
            "EVENT round_crank round={} market={} kind={} hash={} {who}",
            run.round,
            c.market,
            c.kind,
            hash_hex(&c.run_hash)
        ));
        if run.markets[c.market].runs.len() == CRANKS_PER_MARKET {
            let m = &run.markets[c.market];
            env::log_str(&format!(
                "EVENT round_market round={} colony={} swarm={:?} market_hash={}",
                run.round,
                m.colony,
                m.swarm.as_ref().unwrap(),
                hash_hex(&m.market_hash.unwrap())
            ));
        }
        let view = RoundRunView::from(&run);
        self.round_run = Some(run);
        view
    }

    /// The newest finished round: its markets as the keepers posted them and
    /// the colonies' results, for re-running in the browser. `null` until a
    /// round has finished and the next one has started.
    pub fn last_round(&self) -> Option<LastRoundView> {
        self.last_round.as_ref().map(|(r, ms)| LastRoundView {
            markets: ms.iter().map(MarketView::from).collect(),
            run: RoundRunView::from(r),
        })
    }

    /// The newest burn day that was executed, if any.
    pub fn last_burn_day(&self) -> Option<u64> {
        self.burn.last_day()
    }

    /// Permissionless: open the next round once the current one is over (all
    /// colonies run, no quorum by the publish time, or abandoned a day after
    /// it). Every forecast colony stake goes back to its owner, keepers post
    /// the new round's market, and staking opens for `stake_ms`.
    pub fn start_round(&mut self) -> u64 {
        require!(!self.paused, "paused");
        let now = env::block_timestamp_ms();
        let cfg = self.staking.config();
        let over = match (&self.round_run, self.markets.markets()) {
            (Some(r), _) => r.done || now >= cfg.publish_at + ROUND_GRACE_MS,
            (None, None) => now >= cfg.publish_at,
            (None, Some(_)) => now >= cfg.publish_at + ROUND_GRACE_MS,
        };
        require!(over, "the round is not over");
        let next = StakeConfig {
            cap_per_wallet: cfg.cap_per_wallet,
            close_at: now + self.round_cfg.stake_ms,
            publish_at: now + self.round_cfg.stake_ms + self.round_cfg.gap_ms,
        };
        let old_markets = self.markets.markets().map(|m| m.to_vec());
        let refunds = ok(self.staking.reopen(&mut self.ledger, next));
        for (who, amount) in refunds {
            env::log_str(&format!("EVENT refund {who} amount={amount}"));
        }
        self.markets.reopen(next.close_at);
        self.agents.clear_round();
        if let (Some(r), Some(ms)) = (self.round_run.take(), old_markets) {
            if r.done {
                self.last_round = Some((r, ms));
            }
        }
        self.round += 1;
        env::log_str(&format!(
            "EVENT round_start round={} close_at={} publish_at={}",
            self.round, next.close_at, next.publish_at
        ));
        self.round
    }

    // ---- Recruit the swarm: requested forecasts ----

    /// Pay the request fee and name a Polymarket market by its slug. Returns
    /// the request id; the request runs as colony 0x8000 + id.
    pub fn request_forecast(&mut self, market_id: String) -> u32 {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        let id = ok(self.requests.request(
            &mut self.ledger,
            env::block_timestamp_ms(),
            who.as_str(),
            &market_id,
        ));
        let r = self.requests.get(id).unwrap();
        env::log_str(&format!(
            "EVENT request id={id} colony={} market={market_id} by={who} fee={} odds_by={}",
            r.colony, r.fee, r.odds_by
        ));
        id
    }

    /// Keeper only: post or replace this keeper's odds for a request.
    pub fn post_request_odds(&mut self, request_id: u32, market: MarketPostView) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        ok(self.requests.post_odds(
            &self.markets,
            env::block_timestamp_ms(),
            who.as_str(),
            request_id,
            market.into(),
        ));
        env::log_str(&format!("EVENT post_request_odds id={request_id} {who}"));
    }

    /// Permissionless from the odds deadline, or once every keeper posted.
    /// Accepts the quorum's median odds, or skips the request and refunds.
    pub fn finalize_request_odds(&mut self, request_id: u32) -> RequestView {
        let r = ok(self.requests.finalize_odds(
            &mut self.ledger,
            &self.markets,
            env::block_timestamp_ms(),
            request_id,
        ));
        match &r.market {
            Some(m) => env::log_str(&format!(
                "EVENT request_odds id={request_id} odds={:?} odds_6h={:?} odds_hash={} forecast_by={}",
                m.odds,
                m.odds_6h,
                hash_hex(&m.odds_hash),
                r.forecast_by.unwrap_or(0)
            )),
            None => env::log_str(&format!(
                "EVENT request_skipped id={request_id} refund={}",
                r.fee
            )),
        }
        RequestView::from(r)
    }

    /// Permissionless once the agents' window closed: run the next of the five
    /// colonies and earn the crank bounty. The first call draws the seed and
    /// must pass the signature of the request's `drand_round`.
    pub fn crank_request(&mut self, request_id: u32, drand_signature: Option<String>) -> RequestView {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        // Only the seed-drawing call needs the beacon; any other call either
        // has its seed already or fails on the request's own checks.
        let draw = self.requests.get(request_id).and_then(|r| match r.phase {
            Phase::Forecasting => r.forecast_by.filter(|by| now >= *by),
            _ => None,
        });
        let entropy: [u8; 32] = match draw {
            Some(by) => drand::entropy(drand::round_after(by), drand_signature.as_deref()),
            None => [0; 32],
        };
        let c = ok(self.requests.crank(
            &mut self.ledger,
            &mut self.agents,
            &self.staking,
            now,
            who.as_str(),
            request_id,
            entropy,
            env::current_account_id().as_str(),
        ));
        let r = self.requests.get(request_id).unwrap();
        if c.drew_seed {
            let ag = r.agents.as_ref().unwrap();
            let st = r.stakes.as_ref().unwrap();
            env::log_str(&format!(
                "EVENT request_seed id={request_id} seed={} agent_odds={:?} agent_hash={} weights={:?} stake_hash={} drand={} randomness={}",
                hash_hex(&r.seed.unwrap()),
                ag.odds,
                hash_hex(&ag.hash),
                st.weights,
                hash_hex(&st.hash),
                draw.map_or(0, drand::round_after),
                hash_hex(&entropy)
            ));
        }
        env::log_str(&format!(
            "EVENT crank id={request_id} kind={} hash={} {who} bounty={}",
            c.kind,
            hash_hex(&c.run_hash),
            c.bounty
        ));
        if c.done {
            env::log_str(&format!(
                "EVENT request_done id={request_id} swarm={:?} market_hash={} burned={}",
                r.swarm.as_ref().unwrap(),
                hash_hex(&r.market_hash.unwrap()),
                r.payouts.burned
            ));
        }
        RequestView::from(r)
    }

    pub fn request_config(&self) -> RequestConfigView {
        self.requests.config().into()
    }

    /// Requests made so far; ids run from 0 to this minus one.
    pub fn forecast_request_count(&self) -> u32 {
        self.requests.count()
    }

    pub fn forecast_request(&self, request_id: u32) -> Option<RequestView> {
        self.requests.get(request_id).map(RequestView::from)
    }

    /// Up to `limit` (at most 50) requests from id `from_id`, oldest first.
    pub fn forecast_requests(&self, from_id: u32, limit: u32) -> Vec<RequestView> {
        self.requests
            .list(from_id, limit.min(50) as usize)
            .into_iter()
            .map(RequestView::from)
            .collect()
    }

    // ---- forecaster agents ----

    /// Become a forecaster agent: moves the refundable deposit into the vault.
    pub fn register_agent(&mut self) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        let deposit = self.requests.config().agent_deposit;
        ok(self
            .agents
            .register(&mut self.ledger, who.as_str(), deposit));
        env::log_str(&format!("EVENT register_agent {who} deposit={deposit}"));
    }

    /// Refund the deposit. Allowed while paused so a pause never traps it.
    /// Open posts stop counting.
    pub fn unregister_agent(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let refund = ok(self.agents.unregister(&mut self.ledger, who.as_str()));
        env::log_str(&format!("EVENT unregister_agent {who} refund={refund}"));
        U128(refund)
    }

    /// Agent only: post or replace your odds (basis points, one per outcome,
    /// summing to 10000) for a requested market's colony while its agents'
    /// window is open, or for a trending market's colony once the round's
    /// markets are finalized and until the round's publish time.
    pub fn post_forecast(&mut self, colony: u16, odds: Vec<u16>) {
        require!(!self.paused, "paused");
        let who = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let n = ok(self.forecast_window(colony, now));
        ok(self.agents.post(who.as_str(), colony, n, odds.clone()));
        env::log_str(&format!(
            "EVENT post_forecast colony={colony} {who} odds={odds:?}"
        ));
    }

    /// The agent-odds snapshot of a colony: frozen for a cranked request,
    /// otherwise what it would be if posting closed now.
    pub fn agent_snapshot(&self, colony: u16) -> Option<AgentSnapshotView> {
        if let Some(r) = Requests::id_of(colony).and_then(|id| self.requests.get(id)) {
            if let Some(s) = &r.agents {
                return Some(s.into());
            }
            return r
                .n_outcomes()
                .map(|n| (&self.agents.preview(colony, n)).into());
        }
        let m = self.trending_market(colony)?;
        Some((&self.agents.preview(colony, m.outcomes.len())).into())
    }

    pub fn is_agent(&self, account_id: AccountId) -> bool {
        self.agents.is_registered(account_id.as_str())
    }

    pub fn agents(&self) -> Vec<AccountId> {
        self.agents
            .registered()
            .map(|a| a.parse().unwrap())
            .collect()
    }

    // ---- burn ----

    /// Permissionless from 12:00 UTC: the first call for a day draws the seed
    /// (passing the signature of `burn_schedule().drand_round`) and starts the
    /// Burn colony from the day's frozen stakes; each later call steps it up
    /// to the clock (one tick a second since 12:00, at most `TICKS_PER_CALL`
    /// per call). The last tick falls at 24:00, so the winner is only known
    /// then. A day's run may start late, until the next day's 12:00, and then
    /// catches up. The call that starts a day first burns the day before if
    /// nobody executed it, and logs `burn_skipped` if its run never finished.
    pub fn crank_burn(&mut self, drand_signature: Option<String>) -> BurnRunView {
        require!(!self.paused, "paused");
        let now = env::block_timestamp_ms();
        let who = env::predecessor_account_id();
        // The newest drawn day runs from its 12:00 until the next day's.
        let day = day::drawn_day(now)
            .unwrap_or_else(|| ok(Err(Error::BurnNotRunning(now / day::DAY_MS))));
        let carry = self
            .burn_run
            .as_ref()
            .is_some_and(|r| !r.is_done() && r.day == day);
        let mut run_colony = match self.burn_run.clone() {
            Some(r) if carry => {
                let bytes = env::storage_read(BURN_COLONY_KEY)
                    .unwrap_or_else(|| env::panic_str("burn colony state missing"));
                let colony = Colony::from_bytes(&bytes)
                    .unwrap_or_else(|_| env::panic_str("bad burn colony state"));
                (r, colony)
            }
            Some(r) if r.day == day => ok(Err(Error::NothingToCrank)),
            prev => {
                // A new day replaces the older run: burn it first if it
                // finished and nobody executed it, else it is skipped.
                if let Some(p) = prev {
                    let unburned = self.burn.last_day().is_none_or(|l| l < p.day);
                    // Checked first: a day that can't burn mustn't block the next.
                    let can_burn = p.decision(now).is_ok()
                        && self.staking.burn_snapshot(p.day, now).is_ok();
                    if unburned && can_burn {
                        self.execute_day(p.day, now);
                    } else if unburned {
                        env::log_str(&format!("EVENT burn_skipped day={} t={}", p.day, p.t));
                    }
                }
                let snap = ok(self.staking.freeze_burn(day, now));
                let drand_round = drand::round_after(day::run_at(day));
                let entropy = drand::entropy(drand_round, drand_signature.as_deref());
                let (run, colony) = ok(BurnRun::start(
                    now,
                    entropy,
                    env::current_account_id().as_str(),
                    &snap,
                    day,
                ));
                env::log_str(&format!(
                    "EVENT burn_seed day={day} seed={} stakes={} drand={drand_round} randomness={}",
                    hash_hex(&run.seed),
                    hash_hex(&run.stake_hash),
                    hash_hex(&entropy)
                ));
                (run, colony)
            }
        };
        let (run, colony) = (&mut run_colony.0, &mut run_colony.1);
        let c = if run.t == 0 && colony.t == 0 && run.allowed(now) == 0 {
            // The starting call right at 12:00: nothing to step yet.
            antotoken::burnrun::BurnCrank {
                steps: 0,
                done: false,
            }
        } else {
            ok(run.advance(colony, now))
        };
        env::storage_write(BURN_COLONY_KEY, &colony.to_bytes());
        env::log_str(&format!(
            "EVENT burn_crank day={day} t={} steps={} {who}",
            run.t, c.steps
        ));
        if c.done {
            let r = run.result.as_ref().unwrap();
            env::log_str(&format!(
                "EVENT burn_run_done day={day} winner={} hash={}",
                r.winner_option,
                hash_hex(&r.hash)
            ));
        }
        let view = BurnRunView::from(&*run);
        self.burn_run = Some(run_colony.0);
        view
    }

    /// The day's Burn colony run, if it was started; the winner shows once the
    /// last tick is in.
    pub fn burn_run(&self) -> Option<BurnRunView> {
        self.burn_run.as_ref().map(BurnRunView::from)
    }

    /// Permissionless from 24:00 UTC of `day`, once the colony has run its
    /// last tick: burn the menu amount the colony picked, once per day and in
    /// day order, and pay the day's rewards to the stakers on that index.
    /// There is no `index` argument and no trusted colony account.
    pub fn execute_burn(&mut self, day: u64) -> U128 {
        require!(!self.paused, "paused");
        U128(self.execute_day(day, env::block_timestamp_ms()))
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

    // ---- operations ----

    /// Re-times every round `start_round` opens from now on; the round under
    /// way keeps its times. Only the contract account itself may call it.
    pub fn set_round_config(&mut self, round_config: RoundConfig) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account may re-time rounds"
        );
        require!(round_config.stake_ms > 0, "staking needs a window");
        self.round_cfg = round_config;
        env::log_str(&format!(
            "EVENT round_config stake_ms={} gap_ms={}",
            round_config.stake_ms, round_config.gap_ms
        ));
    }

    pub fn round_config(&self) -> RoundConfig {
        self.round_cfg
    }

    /// Sets what `claim_play_tokens` pays from now on; accounts that already
    /// claimed don't claim again. Only the contract account itself may call it.
    pub fn set_faucet_amount(&mut self, faucet_amount: U128) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account may set the faucet"
        );
        self.faucet_amount = faucet_amount.0;
        env::log_str(&format!("EVENT faucet_amount amount={}", faucet_amount.0));
    }
}

impl Contract {
    /// Burn `day`'s pick and pay its rewards. `burn_run` must be that day's
    /// finished run and the day must be over.
    fn execute_day(&mut self, day: u64, now: u64) -> u128 {
        let run = match &self.burn_run {
            Some(r) if r.day == day => r,
            _ => ok(Err(Error::NoBurnRun(day))),
        };
        let index = ok(run.decision(now));
        let burned = ok(self.burn.execute(
            &mut self.ledger,
            self.treasury.as_str(),
            day,
            index,
        ));
        let snap = ok(self.staking.take_burn_snapshot(day, now));
        env::log_str(&format!(
            "EVENT burn day={day} index={index} amount={burned} stakes={}",
            hash_hex(&snap.hash)
        ));
        let paid = ok(self
            .rewards
            .distribute(&mut self.ledger, day, index as u8, &snap.entries));
        for (who, amount) in paid {
            env::log_str(&format!("EVENT reward day={day} {who} amount={amount}"));
        }
        burned
    }

    fn trending_market(&self, colony: u16) -> Option<&Market> {
        self.markets.markets()?.iter().find(|m| m.colony == colony)
    }

    /// Outcome count of `colony` if agents may post on it at `now`.
    fn forecast_window(&self, colony: u16, now: u64) -> Result<usize, Error> {
        if Requests::id_of(colony).is_some() {
            return self.requests.forecast_window(colony, now);
        }
        let m = self.trending_market(colony).ok_or(Error::BadColony)?;
        if now >= self.staking.config().publish_at {
            return Err(Error::PostingClosed);
        }
        Ok(m.outcomes.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const ONE: u128 = antotoken::ledger::ONE;
    /// Day 0 (1970-01-01): stakes freeze at NOON, the burn may run from END.
    const NOON: u64 = day::STAKING_MS;
    const END: u64 = day::DAY_MS;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// drand round 1's signature: block times in these tests come before
    /// quicknet's genesis, so every seed commits to round 1.
    fn sig() -> Option<String> {
        Some(drand::tests::ROUND_1_SIG.to_string())
    }

    /// Before a code-only redeploy: save the live `STATE` value's raw bytes
    /// (RPC `view_state`) to a file, then run
    /// `ANTO_STATE=<file> cargo test -- --ignored live_state`. This code must
    /// read them back and write the same bytes, or the redeploy breaks state.
    #[test]
    #[ignore]
    fn live_state_round_trips() {
        let bytes = std::fs::read(std::env::var("ANTO_STATE").unwrap()).unwrap();
        let state: Contract = near_sdk::borsh::from_slice(&bytes).unwrap();
        assert_eq!(near_sdk::borsh::to_vec(&state).unwrap(), bytes);
    }

    fn ctx(who: &str, ms: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(acct(who))
            .block_timestamp(ms * 1_000_000);
        b
    }

    /// Sample values; the real fee and split are still open.
    fn sample_request_config() -> RequestConfigView {
        RequestConfigView {
            fee: U128(100 * ONE),
            keeper_bps: 2_000,
            agent_bps: 3_000,
            crank_bps: 1_000,
            odds_window_ms: 600_000,
            forecast_window_ms: 1_800_000,
            agent_deposit: U128(10 * ONE),
            crank_bounty: U128(0),
        }
    }

    fn fresh() -> Contract {
        testing_env!(ctx("treasury.test", 0).build());
        let mut c = Contract::new(
            acct("treasury.test"),
            acct("guardian.test"),
            U128(1_000_000 * ONE),
            U128(100 * ONE),
            1_000,
            2_000,
            vec![acct("k1.test"), acct("k2.test"), acct("k3.test")],
            2,
            sample_request_config(),
            RoundConfig {
                stake_ms: 5_000,
                gap_ms: 1_000,
            },
            U128(100 * ONE),
        );
        testing_env!(ctx("treasury.test", 0)
            .attached_deposit(near_sdk::NearToken::from_yoctonear(1))
            .build());
        c.ft_transfer(acct("alice.test"), U128(500 * ONE), None);
        c
    }

    fn one_yocto(who: &str, ms: u64) -> VMContextBuilder {
        let mut b = ctx(who, ms);
        b.attached_deposit(near_sdk::NearToken::from_yoctonear(1))
            .prepaid_gas(Gas::from_tgas(100));
        b
    }

    /// `ft_resolve_transfer` as the runtime calls it, with the receiver's answer.
    fn resolve(c: &mut Contract, answer: near_sdk::PromiseResult, amount: u128) -> u128 {
        testing_env!(
            ctx("anto.test", 1).current_account_id(acct("anto.test")).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![answer],
        );
        c.ft_resolve_transfer(acct("alice.test"), acct("dex.test"), U128(amount)).0
    }

    #[test]
    fn transfer_call_moves_tokens_then_refunds_what_the_receiver_left() {
        use near_sdk::PromiseResult::{Failed, Successful};
        let mut c = fresh();
        testing_env!(one_yocto("alice.test", 1).build());
        let r = c.ft_transfer_call(acct("dex.test"), U128(100 * ONE), None, "swap".into());
        assert!(matches!(r, PromiseOrValue::Promise(_)));
        assert_eq!(c.ft_balance_of(acct("dex.test")).0, 100 * ONE);
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 400 * ONE);

        // The receiver kept 70 and returned 30.
        let ans = |n: u128| Successful(format!("\"{n}\"").into_bytes());
        assert_eq!(resolve(&mut c, ans(30 * ONE), 100 * ONE), 70 * ONE);
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 430 * ONE);
        assert_eq!(c.ft_balance_of(acct("dex.test")).0, 70 * ONE);

        // Asking back more than was sent refunds at most the amount, and at
        // most what the receiver still holds.
        assert_eq!(resolve(&mut c, ans(500 * ONE), 100 * ONE), 30 * ONE);
        assert_eq!(c.ft_balance_of(acct("dex.test")).0, 0);
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 500 * ONE);

        // A failed receiver call or garbage refunds everything it can.
        give(&mut c, "dex.test", 20 * ONE);
        assert_eq!(resolve(&mut c, Failed, 10 * ONE), 0);
        assert_eq!(resolve(&mut c, Successful(b"nope".to_vec()), 10 * ONE), 0);
        assert_eq!(c.ft_balance_of(acct("dex.test")).0, 0);
        assert_eq!(resolve(&mut c, ans(0), 10 * ONE), 10 * ONE);
    }

    #[test]
    fn transfer_call_needs_one_yocto_gas_and_another_receiver() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 1).prepaid_gas(Gas::from_tgas(100)).build());
        assert!(panics(|| {
            let _ = c.ft_transfer_call(acct("dex.test"), U128(ONE), None, String::new());
        }));
        testing_env!(one_yocto("alice.test", 1).prepaid_gas(Gas::from_tgas(30)).build());
        assert!(panics(|| {
            let _ = c.ft_transfer_call(acct("dex.test"), U128(ONE), None, String::new());
        }));
        testing_env!(one_yocto("alice.test", 1).build());
        assert!(panics(|| {
            let _ = c.ft_transfer_call(acct("alice.test"), U128(ONE), None, String::new());
        }));
        assert!(panics(|| {
            let _ = c.ft_transfer_call(acct("dex.test"), U128(501 * ONE), None, String::new());
        }));
        // The resolve callback is private.
        testing_env!(ctx("alice.test", 1).build());
        assert!(panics(|| {
            c.ft_resolve_transfer(acct("alice.test"), acct("dex.test"), U128(ONE));
        }));
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 500 * ONE);
    }

    #[test]
    fn storage_is_free_and_unregister_drops_or_burns() {
        let mut c = fresh();
        assert_eq!(c.storage_balance_bounds().max.unwrap().0, 0);
        let b = c.storage_balance_of(acct("nobody.test")).unwrap();
        assert_eq!((b.total.0, b.available.0), (0, 0));
        testing_env!(ctx("bob.test", 1)
            .attached_deposit(near_sdk::NearToken::from_millinear(125))
            .build());
        assert_eq!(c.storage_deposit(None, Some(true)).total.0, 0);
        let refunds = near_sdk::test_utils::get_created_receipts();
        assert_eq!(refunds.len(), 1, "the deposit goes back");
        assert_eq!(refunds[0].receiver_id, acct("bob.test"));

        testing_env!(one_yocto("bob.test", 1).build());
        assert_eq!(c.storage_withdraw(None).available.0, 0);
        assert!(panics(|| {
            c.storage_withdraw(Some(U128(1)));
        }));
        assert!(!c.storage_unregister(None), "bob never had an entry");

        let supply = c.ft_total_supply().0;
        testing_env!(one_yocto("alice.test", 1).build());
        c.stake(0, 1, U128(10 * ONE));
        assert!(panics(|| {
            c.storage_unregister(None);
        }));
        assert!(c.storage_unregister(Some(true)));
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 0);
        assert_eq!(c.ft_total_supply().0, supply - 490 * ONE);
        assert_eq!(c.staked_by(acct("alice.test")).0, 10 * ONE, "stakes untouched");
        assert!(!c.storage_unregister(None));

        testing_env!(one_yocto("treasury.test", 1).build());
        assert!(panics(|| {
            c.storage_unregister(Some(true));
        }));
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
        c.stake(1, 2, U128(25 * ONE));
        assert_eq!(c.staked_by(acct("alice.test")).0, 25 * ONE);
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 475 * ONE);
        assert_eq!(c.stake_weights(1, 3)[2].0, antotoken::isqrt(25 * ONE));
        assert_eq!(c.stake_totals(1, 3)[2].0, 25 * ONE);
        let mine = c.stakes_of(acct("alice.test"));
        assert_eq!(mine.len(), 1);
        assert_eq!((mine[0].0, mine[0].1, mine[0].2 .0), (1, 2, 25 * ONE));
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
        c.stake(1, 0, U128(ONE));
    }

    #[test]
    #[should_panic(expected = "NoBurnRun(0)")]
    fn burn_needs_a_colony_run() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", END).build());
        c.execute_burn(0);
    }

    #[test]
    #[should_panic(expected = "BurnNotFinished(0)")]
    fn burn_needs_the_last_tick() {
        let mut c = fresh();
        c.burn_run = Some(BurnRun {
            day: 0,
            seed: [0; 32],
            stake_hash: [0; 32],
            t: 10,
            result: None,
        });
        testing_env!(ctx("alice.test", END).build());
        c.execute_burn(0);
    }

    #[test]
    fn colony_burn_lowers_supply_by_menu_amount() {
        let mut c = fresh();
        let treasury_before = c.ft_balance_of(acct("treasury.test")).0;
        finished_burn(&mut c, 0, 4);
        // Anyone may execute it: the index is the colony's, not the caller's.
        testing_env!(ctx("anyone.test", END).build());
        let burned = c.execute_burn(0).0;
        assert_eq!(burned, treasury_before / 50);
        assert_eq!(c.ft_total_supply().0, 1_000_000 * ONE - burned);
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
        finished_burn(&mut c, 0, 0);
        testing_env!(ctx("anyone.test", END).build());
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.execute_burn(0)))
                .is_err()
        );
    }

    #[test]
    fn round_config_times_the_next_round() {
        let mut c = fresh();
        let mut b = ctx("contract.test", 0);
        b.current_account_id(acct("contract.test"));
        testing_env!(b.build());
        c.set_round_config(RoundConfig { stake_ms: 1_200, gap_ms: 300 });
        assert_eq!(c.round_config().stake_ms, 1_200);
        // The round under way keeps its times; the next one gets the new ones.
        assert_eq!(c.round_status().close_at_ms, 1_000);
        testing_env!(ctx("anyone.test", 2_000).build());
        assert_eq!(c.start_round(), 1);
        let r = c.round_status();
        assert_eq!((r.close_at_ms, r.publish_at_ms), (3_200, 3_500));
    }

    #[test]
    fn only_the_contract_retimes_rounds() {
        let mut c = fresh();
        let mut b = ctx("alice.test", 0);
        b.current_account_id(acct("contract.test"));
        testing_env!(b.build());
        assert!(panics(|| c.set_round_config(RoundConfig { stake_ms: 1, gap_ms: 1 })));
        assert_eq!(c.round_config().stake_ms, 5_000);
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
        c.stake(1, 0, U128(10 * ONE));
        testing_env!(ctx("alice.test", 1_500).build());
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.unstake(1, 0, U128(ONE))))
                .is_err()
        );
        testing_env!(ctx("anyone.test", 2_000).build());
        c.settle();
        testing_env!(ctx("alice.test", 2_001).build());
        c.unstake(1, 0, U128(10 * ONE));
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 500 * ONE);
    }

    #[test]
    #[should_panic(expected = "BurnDayNotOver(0)")]
    fn burn_waits_for_the_day_to_end() {
        let mut c = fresh();
        finished_burn(&mut c, 0, 0);
        testing_env!(ctx("anyone.test", END - 1).build());
        c.execute_burn(0);
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

        finished_burn(&mut c, 0, 2);
        testing_env!(ctx("anyone.test", END).build());
        c.execute_burn(0);
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

    fn panics(f: impl FnOnce()) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    /// A finished Burn colony run for `day` that picked menu entry `index`,
    /// without paying for 43,200 debug-mode ticks. The real run has its own test.
    fn finished_burn(c: &mut Contract, day: u64, index: u8) {
        use antotoken::burnrun::BurnResult;
        c.burn_run = Some(BurnRun {
            day,
            seed: [0; 32],
            stake_hash: [0; 32],
            t: BURN_TICKS,
            result: Some(BurnResult {
                hash: [0; 32],
                winner_option: index,
                winner_source: index,
                scores: vec![0; 5],
                perm: vec![0, 1, 2, 3, 4],
            }),
        });
    }

    #[test]
    fn burn_day_freezes_at_noon_locks_the_run_and_burns_once() {
        let mut c = fresh();
        give(&mut c, "bob.test", 100 * ONE);
        testing_env!(ctx("treasury.test", 0).build());
        c.fund_rewards(U128(1_000 * ONE));
        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 2, U128(10 * ONE));
        let s = c.burn_schedule();
        assert_eq!(
            (
                s.day,
                s.phase.as_str(),
                s.run_at_ms,
                s.end_at_ms,
                s.drawn_day
            ),
            (0, "staking", NOON, END, None)
        );

        // Bob stakes after 12:00: that counts from day 1, not day 0.
        testing_env!(ctx("bob.test", NOON + 1).build());
        c.stake(0, 2, U128(10 * ONE));
        assert_eq!(c.burn_schedule().phase, "running");
        assert_eq!(c.burn_snapshot(0).entries.len(), 1);
        // Nobody can withdraw a Burn stake while the colony runs.
        testing_env!(ctx("alice.test", END - 1).build());
        assert!(panics(|| c.unstake(0, 2, U128(ONE))));

        finished_burn(&mut c, 0, 2);
        testing_env!(ctx("anyone.test", END).build());
        c.execute_burn(0);
        assert_eq!(c.rewards_earned(acct("alice.test")).0, 100 * ONE);
        assert_eq!(c.rewards_earned(acct("bob.test")).0, 0);
        assert!(panics(|| {
            c.execute_burn(0);
        }));
        // Withdrawing is open again after 24:00.
        testing_env!(ctx("alice.test", END).build());
        c.unstake(0, 2, U128(10 * ONE));
    }

    const SLUG: &str = "fed-decision-in-december";

    fn request_market(odds: Vec<u16>) -> MarketPostView {
        MarketPostView {
            market_id: SLUG.into(),
            outcomes: vec!["Cut".into(), "Hold".into(), "Hike".into()],
            odds_6h: odds.clone(),
            odds,
            raw_hash: "cd".repeat(32),
        }
    }

    #[test]
    fn requested_forecast_end_to_end() {
        let mut c = fresh();
        give(&mut c, "agent-a.test", 50 * ONE);
        give(&mut c, "agent-b.test", 50 * ONE);
        let supply = c.ft_total_supply().0;

        testing_env!(ctx("alice.test", 5_000).build());
        let id = c.request_forecast(SLUG.into());
        assert_eq!(id, 0);
        assert_eq!(c.forecast_request_count(), 1);
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 400 * ONE);
        assert_eq!(c.request_config().crank_bounty.0, 2 * ONE);

        for (k, odds) in [
            ("k1.test", vec![6200, 2800, 1000]),
            ("k2.test", vec![6000, 3000, 1000]),
        ] {
            testing_env!(ctx(k, 5_001).build());
            c.post_request_odds(id, request_market(odds));
        }
        assert_eq!(c.forecast_request(id).unwrap().keepers_posted.len(), 2);
        testing_env!(ctx("anyone.test", 605_000).build());
        let r = c.finalize_request_odds(id);
        assert_eq!(r.phase, "forecasting");
        assert_eq!(r.market.as_ref().unwrap().odds, vec![6000, 2800, 1000]);
        let colony = r.colony;
        assert_eq!(colony, 0x8000);

        for (a, odds) in [
            ("agent-a.test", vec![5000, 4000, 1000]),
            ("agent-b.test", vec![4000, 4000, 2000]),
        ] {
            testing_env!(ctx(a, 605_001).build());
            c.register_agent();
            c.post_forecast(colony, odds);
        }
        assert!(c.is_agent(acct("agent-a.test")));
        // Holders stake on the request's colony during the agents' window,
        // long after the round's own staking closed.
        testing_env!(ctx("alice.test", 605_002).build());
        c.stake(colony, 2, U128(16 * ONE));
        assert!(panics(|| c.stake(colony, 3, U128(ONE))));
        assert_eq!(c.stake_totals(colony, 3)[2].0, 16 * ONE);
        let preview = c.agent_snapshot(colony).unwrap();
        assert_eq!(preview.odds, vec![4000, 4000, 1000]);

        let close = 605_000 + 1_800_000;
        testing_env!(ctx("agent-a.test", close).build());
        assert!(panics(|| c.post_forecast(colony, vec![5000, 5000, 0])));
        // Cranking waits for the agents' window to close.
        testing_env!(ctx("cranker.test", close - 1).build());
        assert!(panics(|| {
            c.crank_request(id, sig());
        }));
        testing_env!(ctx("alice.test", close).build());
        assert!(panics(|| c.unstake(colony, 2, U128(ONE))), "locked until done");
        let mut last = None;
        for i in 0..5 {
            testing_env!(ctx("cranker.test", close + i).random_seed([9; 32]).build());
            last = Some(c.crank_request(id, sig()));
        }
        let r = last.unwrap();
        assert_eq!(r.phase, "done");
        assert_eq!(r.colony_hashes.len(), 5);
        assert_eq!(
            r.swarm
                .as_ref()
                .unwrap()
                .iter()
                .map(|&x| x as u32)
                .sum::<u32>(),
            10_000
        );
        assert_eq!(r.agents.as_ref().unwrap().posts.len(), 2);
        assert_eq!(c.ft_balance_of(acct("cranker.test")).0, 10 * ONE);
        assert_eq!(c.ft_balance_of(acct("k1.test")).0, 10 * ONE);
        assert_eq!(r.stakes.as_ref().unwrap().entries.len(), 1);
        // Agents 30 over two: 15 each, on top of 40 left after the deposit.
        assert_eq!(c.ft_balance_of(acct("agent-a.test")).0, 55 * ONE);
        assert_eq!(r.burned.0, 40 * ONE);
        assert_eq!(c.ft_total_supply().0, supply - 40 * ONE);
        assert!(panics(|| {
            c.crank_request(id, sig());
        }));

        // The stored result re-runs from the view alone.
        let m = r.market.as_ref().unwrap();
        let ag = r.agents.as_ref().unwrap();
        let st = r.stakes.as_ref().unwrap();
        assert_eq!(st.weights, vec![0, 0, 4_000], "alice's 16 on Hike");
        let again = antotoken::antosim::forecast_market(
            &parse_hash(r.seed.as_ref().unwrap()).unwrap(),
            colony,
            &m.odds,
            &m.odds_6h,
            &st.weights,
            parse_hash(&st.hash).unwrap(),
            &ag.odds,
            parse_hash(&ag.hash).unwrap(),
            antotoken::antosim::FORECAST_ANTS,
            antotoken::antosim::FORECAST_TICKS,
        )
        .unwrap();
        assert_eq!(hash_hex(&again.hash), r.market_hash.clone().unwrap());

        testing_env!(ctx("alice.test", close + 10).build());
        c.unstake(colony, 2, U128(16 * ONE));
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 400 * ONE);
        testing_env!(ctx("agent-a.test", close + 10).build());
        assert_eq!(c.unregister_agent().0, 10 * ONE);
        assert_eq!(c.ft_balance_of(acct("agent-a.test")).0, 65 * ONE);
    }

    #[test]
    fn no_keeper_quorum_refunds_the_fee() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 0).build());
        let id = c.request_forecast(SLUG.into());
        testing_env!(ctx("k1.test", 1).build());
        c.post_request_odds(id, request_market(vec![6000, 3000, 1000]));
        testing_env!(ctx("anyone.test", 600_000).build());
        assert_eq!(c.finalize_request_odds(id).phase, "skipped");
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, 500 * ONE);
    }

    #[test]
    #[should_panic(expected = "DeniedMarket")]
    fn denied_slugs_are_refused() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 0).build());
        c.request_forecast("missile-strike-by-friday".into());
    }

    #[test]
    #[should_panic(expected = "NotAgent")]
    fn only_agents_post_forecasts() {
        let mut c = fresh();
        for k in ["k1.test", "k2.test"] {
            testing_env!(ctx(k, 10).build());
            c.post_trending(vec![market(vec![6000, 4000])]);
        }
        testing_env!(ctx("anyone.test", 1_000).build());
        c.finalize_markets();
        testing_env!(ctx("alice.test", 1_500).build());
        c.post_forecast(1, vec![5000, 5000]);
    }

    #[test]
    fn agents_post_on_trending_markets_until_publish() {
        let mut c = fresh();
        give(&mut c, "agent-a.test", 50 * ONE);
        for k in ["k1.test", "k2.test"] {
            testing_env!(ctx(k, 10).build());
            c.post_trending(vec![market(vec![6000, 4000])]);
        }
        testing_env!(ctx("agent-a.test", 500).build());
        c.register_agent();
        // Not finalized yet: no market colony to post on.
        assert!(panics(|| c.post_forecast(1, vec![5000, 5000])));
        testing_env!(ctx("anyone.test", 1_000).build());
        c.finalize_markets();
        testing_env!(ctx("agent-a.test", 1_999).build());
        c.post_forecast(1, vec![7000, 3000]);
        assert_eq!(c.agent_snapshot(1).unwrap().odds, vec![7000, 3000]);
        testing_env!(ctx("agent-a.test", 2_000).build());
        assert!(panics(|| c.post_forecast(1, vec![7000, 3000])));
        assert!(c.agent_snapshot(2).is_none());
    }

    #[test]
    fn faucet_pays_once_from_the_treasury() {
        let mut c = fresh();
        let t0 = c.ft_balance_of(acct("treasury.test")).0;
        testing_env!(ctx("newbie.test", 5).build());
        assert!(!c.has_claimed(acct("newbie.test")));
        assert_eq!(c.claim_play_tokens().0, 100 * ONE);
        assert_eq!(c.ft_balance_of(acct("newbie.test")).0, 100 * ONE);
        assert_eq!(c.ft_balance_of(acct("treasury.test")).0, t0 - 100 * ONE);
        assert!(c.has_claimed(acct("newbie.test")));
        assert!(panics(|| {
            c.claim_play_tokens();
        }));
        assert_eq!(c.ft_total_supply().0, 1_000_000 * ONE, "no new supply");
    }

    #[test]
    fn the_contract_account_can_raise_the_faucet() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 5).build());
        assert!(panics(|| c.set_faucet_amount(U128(150 * ONE))));
        testing_env!(ctx("alice.test", 5).current_account_id(acct("alice.test")).build());
        c.set_faucet_amount(U128(150 * ONE));
        assert_eq!(c.faucet_amount().0, 150 * ONE);
        // Enough for a request fee (100) and an agent deposit (10).
        testing_env!(ctx("newbie.test", 5).build());
        assert_eq!(c.claim_play_tokens().0, 150 * ONE);
    }

    #[test]
    fn a_seed_needs_its_drand_rounds_signature() {
        let mut c = fresh();
        give(&mut c, "bob.test", 10 * ONE);
        assert_eq!(c.round_status().drand_round, 1);
        testing_env!(ctx("keeper.test", NOON).build());
        assert_eq!(c.burn_schedule().drand_round, Some(1));
        let msg = |f: &mut dyn FnMut()| {
            let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_err();
            e.downcast_ref::<String>().cloned().unwrap_or_default()
        };
        assert!(msg(&mut || {
            c.crank_burn(None);
        })
        .contains("drand round 1: signature needed"));
        let round_2 = Some(drand::tests::BEACONS[1].1.to_string());
        assert!(msg(&mut || {
            c.crank_burn(round_2.clone());
        })
        .contains("not drand round 1's signature"));
        // The real beacon starts the run, and its randomness is in the seed.
        let v = c.crank_burn(sig());
        assert_eq!(v.drand_round, 1);
        let mut buf = antotoken::burnrun::SEED_TAG.to_vec();
        buf.extend_from_slice(&env::sha256_array(
            (0..48)
                .map(|i| u8::from_str_radix(&drand::tests::ROUND_1_SIG[2 * i..2 * i + 2], 16).unwrap())
                .collect::<Vec<u8>>(),
        ));
        buf.extend_from_slice(&0u64.to_be_bytes());
        buf.extend_from_slice(env::current_account_id().as_bytes());
        assert_eq!(v.seed, hash_hex(&env::sha256_array(&buf)));
    }

    #[test]
    fn a_burn_day_nobody_started_can_start_the_next_morning() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 1, U128(25 * ONE));
        // Nobody called from 12:00 to 24:00 of day 0; at 06:00 on day 1 day 0
        // is still the drawn day, so its run starts and catches up.
        testing_env!(ctx("keeper.test", END + 6 * 3_600_000).build());
        let v = c.crank_burn(sig());
        assert_eq!((v.day, v.t), (0, antotoken::burnrun::TICKS_PER_CALL));
        assert_eq!(c.burn_schedule().drawn_day, Some(0));
        // From day 1's 12:00 day 1 runs, and the unfinished day 0 is skipped.
        testing_env!(ctx("keeper.test", END + NOON).build());
        let v = c.crank_burn(sig());
        assert_eq!(v.day, 1);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.starts_with("EVENT burn_skipped day=0")));
        assert_eq!(c.last_burn_day(), None);
    }

    #[test]
    fn starting_a_new_day_burns_the_finished_day_nobody_executed() {
        let mut c = fresh();
        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 1, U128(25 * ONE));
        testing_env!(ctx("keeper.test", NOON).build());
        c.crank_burn(sig());
        finished_burn(&mut c, 0, 4);
        let supply = c.ft_total_supply().0;
        // Nobody called execute_burn(0); the first crank of day 1 does it.
        testing_env!(ctx("keeper.test", END + NOON).build());
        let v = c.crank_burn(sig());
        assert_eq!(v.day, 1);
        assert_eq!(c.last_burn_day(), Some(0));
        assert!(c.ft_total_supply().0 < supply);
        assert!(panics(|| {
            c.execute_burn(0);
        }));
    }

    fn post_round_market(c: &mut Contract, at: u64) {
        for k in ["k1.test", "k2.test"] {
            testing_env!(ctx(k, at).build());
            c.post_trending(vec![market(vec![6000, 4000])]);
        }
    }

    #[test]
    fn a_round_runs_on_chain_then_the_next_one_starts() {
        let mut c = fresh();
        give(&mut c, "agent-a.test", 50 * ONE);
        assert_eq!(c.round_status().phase, "posting");
        post_round_market(&mut c, 10);
        testing_env!(ctx("alice.test", 20).build());
        c.stake(1, 0, U128(36 * ONE));
        testing_env!(ctx("anyone.test", 1_000).build());
        c.finalize_markets();
        assert_eq!(c.round_status().phase, "agents");
        testing_env!(ctx("agent-a.test", 1_100).build());
        c.register_agent();
        c.post_forecast(1, vec![7000, 3000]);

        // Not before the publish time, and not twice in a row to skip ahead.
        testing_env!(ctx("cranker.test", 1_999).build());
        assert!(panics(|| {
            c.crank_round(sig());
        }));
        let mut last = None;
        for i in 0..CRANKS_PER_MARKET {
            testing_env!(ctx("cranker.test", 2_000 + i as u64)
                .random_seed([4; 32])
                .build());
            last = Some(c.crank_round(sig()));
        }
        let run = last.unwrap();
        assert!(run.done);
        assert_eq!(c.round_status().phase, "done");
        let m = &run.markets[0];
        assert_eq!(m.agents.odds, vec![7000, 3000]);
        assert!(m.weights[0] > 0 && m.weights[1] == 0, "Community read alice's stake");
        // The browser's native run matches.
        let seed: [u8; 32] = {
            let mut o = [0u8; 32];
            for i in 0..32 {
                o[i] = u8::from_str_radix(&run.seed[2 * i..2 * i + 2], 16).unwrap();
            }
            o
        };
        let mut hash = [0u8; 32];
        for i in 0..32 {
            hash[i] = u8::from_str_radix(&run.stake_hash[2 * i..2 * i + 2], 16).unwrap();
        }
        let ag = c.agent_snapshot(1);
        assert!(ag.is_none() || ag.unwrap().posts.is_empty(), "posts were frozen out");
        let ms = c.forecast_markets().unwrap();
        let mut agent_hash = [0u8; 32];
        for i in 0..32 {
            agent_hash[i] = u8::from_str_radix(&m.agents.hash[2 * i..2 * i + 2], 16).unwrap();
        }
        let native = antotoken::antosim::forecast_market(
            &seed,
            1,
            &ms[0].odds,
            &ms[0].odds_6h,
            &m.weights,
            hash,
            &m.agents.odds,
            agent_hash,
            antotoken::antosim::FORECAST_ANTS,
            antotoken::antosim::FORECAST_TICKS,
        )
        .unwrap();
        assert_eq!(m.market_hash.as_deref(), Some(native.hash_hex().as_str()));
        assert_eq!(m.swarm.as_ref(), Some(&native.swarm));

        // Next round: refunds, a clean registry, a new schedule.
        let alice_before = c.ft_balance_of(acct("alice.test")).0;
        testing_env!(ctx("anyone.test", 3_000).build());
        assert_eq!(c.start_round(), 1);
        assert_eq!(c.ft_balance_of(acct("alice.test")).0, alice_before + 36 * ONE);
        let r = c.round_status();
        assert_eq!(
            (r.round, r.phase.as_str(), r.close_at_ms, r.publish_at_ms),
            (1, "posting", 8_000, 9_000)
        );
        assert!(r.markets.is_none() && r.run.is_none());
        let last = c.last_round().unwrap();
        assert_eq!(last.run.round, 0);
        assert_eq!(last.run.markets[0].market_hash, m.market_hash);
        assert_eq!(last.markets[0].market_id, "12345");
        post_round_market(&mut c, 3_100);
        testing_env!(ctx("anyone.test", 8_000).build());
        assert_eq!(c.finalize_markets().len(), 1);
    }

    #[test]
    fn start_round_waits_for_the_round_to_end() {
        let mut c = fresh();
        post_round_market(&mut c, 10);
        testing_env!(ctx("anyone.test", 1_000).build());
        c.finalize_markets();
        // Finalized but not cranked: not over until the grace period.
        testing_env!(ctx("anyone.test", 2_500).build());
        assert!(panics(|| {
            c.start_round();
        }));
        testing_env!(ctx("anyone.test", 2_000 + day::DAY_MS).build());
        assert_eq!(c.start_round(), 1);
    }

    #[test]
    fn a_round_with_no_quorum_is_skipped() {
        let mut c = fresh();
        testing_env!(ctx("k1.test", 10).build());
        c.post_trending(vec![market(vec![6000, 4000])]);
        testing_env!(ctx("anyone.test", 1_500).build());
        assert_eq!(c.round_status().phase, "agents");
        testing_env!(ctx("anyone.test", 2_000).build());
        assert_eq!(c.round_status().phase, "skipped");
        assert_eq!(c.start_round(), 1);
    }

    /// The real thing: stakes freeze at 12:00, three cranks across the day
    /// step the colony with the clock, and the burn is what it picked.
    #[test]
    fn the_burn_colony_runs_with_the_clock_and_burns_its_pick() {
        let mut c = fresh();
        give(&mut c, "bob.test", 100 * ONE);
        testing_env!(ctx("alice.test", 10).build());
        c.stake(0, 1, U128(25 * ONE));
        testing_env!(ctx("bob.test", 10).build());
        c.stake(0, 3, U128(64 * ONE));

        testing_env!(ctx("keeper.test", NOON - 1).build());
        assert!(panics(|| {
            c.crank_burn(sig());
        }));
        // The starting call at 12:00 sharp has no tick to run yet.
        testing_env!(ctx("keeper.test", NOON).random_seed([8; 32]).build());
        let v = c.crank_burn(sig());
        assert_eq!((v.t, v.done, v.winner_option), (0, false, None));
        testing_env!(ctx("keeper.test", NOON + 10_000).build());
        assert_eq!(c.crank_burn(sig()).t, 10);
        // Never ahead of the clock: nothing new to run a moment later.
        testing_env!(ctx("keeper.test", NOON + 10_500).build());
        assert!(panics(|| {
            c.crank_burn(sig());
        }));
        // Catch up in capped calls until 24:00.
        testing_env!(ctx("keeper.test", END - 1).build());
        let mut calls = 0;
        while c.burn_run().unwrap().t < BURN_TICKS - 1 {
            c.crank_burn(sig());
            calls += 1;
        }
        assert_eq!(c.burn_run().unwrap().winner_option, None, "no result before 24:00");
        assert!(panics(|| {
            c.execute_burn(0);
        }));
        testing_env!(ctx("keeper.test", END).build());
        let v = c.crank_burn(sig());
        assert!(v.done && calls > 20);
        let pick = v.winner_option.unwrap() as usize;

        let treasury = c.ft_balance_of(acct("treasury.test")).0;
        let snap = c.burn_snapshot(0);
        assert_eq!(snap.hash, v.stake_hash);
        let weights = antotoken::stake::burn_weights(&[
            ("alice.test".to_string(), 0, 1, 25 * ONE),
            ("bob.test".to_string(), 0, 3, 64 * ONE),
        ]);
        let mut seed = [0u8; 32];
        for i in 0..32 {
            seed[i] = u8::from_str_radix(&v.seed[2 * i..2 * i + 2], 16).unwrap();
        }
        let native = antotoken::antosim::burn_run(
            &antotoken::antosim::colony_seed(&seed, antotoken::antosim::BURN_COLONY, 0),
            &weights,
            {
                let mut h = [0u8; 32];
                for i in 0..32 {
                    h[i] = u8::from_str_radix(&v.stake_hash[2 * i..2 * i + 2], 16).unwrap();
                }
                h
            },
            antotoken::antosim::N_ANTS,
            BURN_TICKS,
        )
        .unwrap();
        assert_eq!(v.result_hash.as_deref(), Some(native.hash_hex().as_str()));
        assert_eq!(pick, native.winner_option);

        testing_env!(ctx("anyone.test", END).build());
        let burned = c.execute_burn(0).0;
        let bps = antotoken::burn::BURN_MENU_BPS[pick] as u128;
        assert_eq!(burned, treasury * bps / 10_000);
    }
}
