//! Recruit the swarm: requested forecasts. Anyone pays the fee in $ANTO to have
//! the swarm forecast a Polymarket market of their choice, and agents do the
//! work around it, paid out of that fee for work, never for being right.
//!
//! Lifecycle of one request:
//! 1. `request`: the requester names the market by its Polymarket slug and the
//!    fee moves into escrow. Slugs with a deny-listed word are refused here;
//!    keepers apply the full content filter off-chain and refuse to post.
//! 2. `post_odds` / `finalize_odds`: allow-listed keepers post the market's
//!    odds until `odds_by`, under the same quorum and lower-median rule as
//!    trending markets (`market::accept`). No quorum means the request is
//!    skipped and the fee refunded.
//! 3. Forecaster agents (`agents`) post their own odds until `forecast_by`.
//! 4. `crank`: permissionless, one colony per call, five calls. The first call
//!    freezes the agent posts and draws the seed. Each call pays the crank
//!    bounty to its caller.
//! 5. After the fifth colony: the swarm belief and market hash are stored and
//!    the rest of the fee is paid out (keepers in the accepted quorum, agents
//!    whose posts counted) and the remainder, dust included, is burned.
//!
//! Stakes: holders stake on the request's colony (`stake`, `unstake`) while
//! the agents' window is open, on the same one-wallet budget as every other
//! colony. From `forecast_by` until the last colony has run they're locked;
//! the first crank freezes them (`RequestStakes`), Community reads their
//! square-root weights, and every colony commits their hash. Community sits
//! out of the swarm belief when nobody staked. Afterwards stakers withdraw
//! with `unstake`; nothing pays them.
//!
//! Seed: sha256(tag, entropy, request id, contract account), with the entropy
//! supplied by the caller of the first crank. The contract passes the
//! randomness of the drand round first published after the agents' window
//! closes (`forecast_by`), checked on-chain.
//!
//! The fee size and split are an open decision; `RequestConfig` takes them at
//! init so the deployment picks them.

use crate::{
    agents::{AgentSnapshot, Agents},
    ledger::{AccountId, Ledger},
    market::{accept, check_post, Market, MarketPost, Registry},
    mul_div,
    stake::{Entry, Staking},
    Error,
};
use antosim::{
    colony_seed, forecast_run, market_result, sha256, voters, SimResult, FORECAST_ANTS,
    FORECAST_TICKS, KINDS,
};
use std::collections::BTreeMap;

/// Account that holds request fees until they are paid out or refunded.
pub const REQUEST_ESCROW: &str = "request-escrow.antonomy";
/// Request `id` runs as colony `REQUEST_COLONY_BASE + id`, clear of the
/// round's market colonies (1 + m).
pub const REQUEST_COLONY_BASE: u16 = 0x8000;
pub const MAX_REQUESTS: u32 = 0x7FFF;
pub const SEED_TAG: &[u8] = b"ANTO-REQ-SEED-v0";
/// One colony per crank call.
pub const CRANKS: usize = KINDS.len();
const BPS: u128 = 10_000;

/// Words a requested slug may not contain: violence, deaths, private
/// individuals. Mirrors `keeper/trending.py`'s word filter. `*` marks a stem.
const DENY: &[&str] = &[
    "kill*",
    "death*",
    "dead",
    "die",
    "dies",
    "died",
    "dying",
    "assassinat*",
    "murder*",
    "shoot*",
    "bomb*",
    "missile*",
    "airstrike*",
    "invade*",
    "invasion",
    "attack*",
    "war",
    "ceasefire",
    "hostage*",
    "terror*",
    "nuclear",
    "casualt*",
    "arrest*",
    "indict*",
    "sentenc*",
    "pregnan*",
    "divorce*",
    "baby",
    "wedding",
    "tweet*",
];

/// True if a word of the slug (split on hyphens) is deny-listed.
pub fn slug_denied(slug: &str) -> bool {
    slug.split('-').any(|w| {
        DENY.iter().any(|d| match d.strip_suffix('*') {
            Some(stem) => w.starts_with(stem),
            None => w == *d,
        })
    })
}

/// Lowercase letters, digits and hyphens, like a Polymarket slug.
fn slug_ok(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= crate::market::MAX_ID_LEN
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct RequestConfig {
    /// Fee per request, in yocto.
    pub fee: u128,
    /// Shares of the fee in basis points; the burn gets the rest.
    pub keeper_bps: u16,
    pub agent_bps: u16,
    pub crank_bps: u16,
    /// Keepers post until `created + odds_window`; agents until the odds are
    /// finalized plus `forecast_window`. Milliseconds.
    pub odds_window: u64,
    pub forecast_window: u64,
    /// Refundable deposit to register as a forecaster agent, in yocto.
    pub agent_deposit: u128,
}

impl RequestConfig {
    fn check(&self) -> Result<(), Error> {
        let shares = self.keeper_bps as u128 + self.agent_bps as u128 + self.crank_bps as u128;
        if self.fee == 0 || shares > BPS {
            return Err(Error::BadRequestConfig);
        }
        Ok(())
    }

    fn share(&self, bps: u16) -> u128 {
        mul_div(self.fee, bps as u128, BPS)
    }

    /// Paid to each crank call: the crank share over the five calls.
    pub fn crank_bounty(&self) -> u128 {
        self.share(self.crank_bps) / CRANKS as u128
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub enum Phase {
    /// Keepers posting the market's odds.
    Odds,
    /// Odds accepted; forecaster agents posting.
    Forecasting,
    /// Seed drawn; cranks running the five colonies.
    Running,
    Done,
    /// No keeper quorum: fee refunded.
    Skipped,
}

/// What a crank call ran: enough of the sim result to rebuild the market result.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct ColonyRun {
    pub hash: [u8; 32],
    pub scores: Vec<u32>,
    pub perm: Vec<u8>,
    pub winner_source: u8,
    pub winner_option: u8,
    pub cranker: AccountId,
}

impl ColonyRun {
    pub(crate) fn sim(&self) -> SimResult {
        SimResult {
            winner_source: self.winner_source as usize,
            winner_option: self.winner_option as usize,
            scores: self.scores.clone(),
            perm: self.perm.clone(),
            sources: vec![],
            hash: self.hash,
        }
    }
}

/// A request colony's stakes, frozen when its seed is drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct RequestStakes {
    /// Sorted by (account, colony, option), as in a round's stake snapshot.
    pub entries: Vec<Entry>,
    /// `stake::hash_entries(entries)`, committed by all five colonies.
    pub hash: [u8; 32],
    /// Community's food: milli sqrt-tokens per outcome (`Staking::sim_weights`).
    pub weights: Vec<u32>,
}

/// Fee payouts of a request, each list sorted by account except `cranks`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Payouts {
    pub keepers: Vec<(AccountId, u128)>,
    pub agents: Vec<(AccountId, u128)>,
    /// One entry per crank call, in call order.
    pub cranks: Vec<(AccountId, u128)>,
    pub burned: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Request {
    pub id: u32,
    pub colony: u16,
    pub requester: AccountId,
    /// Polymarket slug.
    pub market_id: String,
    pub fee: u128,
    pub created_at: u64,
    pub odds_by: u64,
    /// Set when the odds are accepted.
    pub forecast_by: Option<u64>,
    pub phase: Phase,
    /// Keeper posts while the odds are open; cleared once finalized.
    pub keeper_posts: BTreeMap<AccountId, MarketPost>,
    /// The accepted odds (colony = this request's colony).
    pub market: Option<Market>,
    /// Frozen at the first crank.
    pub agents: Option<AgentSnapshot>,
    /// Frozen at the first crank.
    pub stakes: Option<RequestStakes>,
    pub seed: Option<[u8; 32]>,
    /// One per colony cranked so far, in `KINDS` order.
    pub runs: Vec<ColonyRun>,
    pub swarm: Option<Vec<u16>>,
    pub market_hash: Option<[u8; 32]>,
    pub payouts: Payouts,
}

impl Request {
    pub fn n_outcomes(&self) -> Option<usize> {
        self.market.as_ref().map(|m| m.outcomes.len())
    }
}

/// What one crank call did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Crank {
    /// Index in `KINDS` of the colony this call ran.
    pub kind: usize,
    pub run_hash: [u8; 32],
    pub bounty: u128,
    /// True on the call that drew the seed.
    pub drew_seed: bool,
    /// True on the call that ran the last colony and paid the fee out.
    pub done: bool,
}

#[derive(Debug, Clone)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Requests {
    config: RequestConfig,
    requests: BTreeMap<u32, Request>,
}

impl Requests {
    pub fn new(config: RequestConfig) -> Result<Requests, Error> {
        config.check()?;
        Ok(Requests {
            config,
            requests: BTreeMap::new(),
        })
    }

    pub fn config(&self) -> RequestConfig {
        self.config
    }

    pub fn get(&self, id: u32) -> Option<&Request> {
        self.requests.get(&id)
    }

    /// Up to `limit` requests from id `from`, oldest first.
    pub fn list(&self, from: u32, limit: usize) -> Vec<&Request> {
        self.requests
            .range(from..)
            .take(limit)
            .map(|(_, r)| r)
            .collect()
    }

    pub fn count(&self) -> u32 {
        self.requests.len() as u32
    }

    fn get_mut(&mut self, id: u32) -> Result<&mut Request, Error> {
        self.requests.get_mut(&id).ok_or(Error::NoSuchRequest(id))
    }

    /// Request id of a request colony, if `colony` is one.
    pub fn id_of(colony: u16) -> Option<u32> {
        colony
            .checked_sub(REQUEST_COLONY_BASE)
            .map(|i| i as u32)
            .filter(|&i| i < MAX_REQUESTS)
    }

    /// The fee moves from `who` into escrow. Returns the request id.
    pub fn request(
        &mut self,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        market_id: &str,
    ) -> Result<u32, Error> {
        if !slug_ok(market_id) {
            return Err(Error::BadMarket);
        }
        if slug_denied(market_id) {
            return Err(Error::DeniedMarket);
        }
        let id = self.count();
        if id >= MAX_REQUESTS {
            return Err(Error::TooManyRequests);
        }
        ledger.ft_transfer(who, REQUEST_ESCROW, self.config.fee)?;
        self.requests.insert(
            id,
            Request {
                id,
                colony: REQUEST_COLONY_BASE + id as u16,
                requester: who.to_string(),
                market_id: market_id.to_string(),
                fee: self.config.fee,
                created_at: now,
                odds_by: now.saturating_add(self.config.odds_window),
                forecast_by: None,
                phase: Phase::Odds,
                keeper_posts: BTreeMap::new(),
                market: None,
                agents: None,
                stakes: None,
                seed: None,
                runs: vec![],
                swarm: None,
                market_hash: None,
                payouts: Payouts::default(),
            },
        );
        Ok(id)
    }

    /// Keeper only: post or replace this keeper's odds for request `id`.
    pub fn post_odds(
        &mut self,
        keepers: &Registry,
        now: u64,
        who: &str,
        id: u32,
        post: MarketPost,
    ) -> Result<(), Error> {
        if !keepers.keepers().any(|k| k == who) {
            return Err(Error::NotKeeper);
        }
        let r = self.get_mut(id)?;
        if r.phase != Phase::Odds || now >= r.odds_by {
            return Err(Error::PostingClosed);
        }
        if post.market_id != r.market_id {
            return Err(Error::BadMarket);
        }
        check_post(&post)?;
        r.keeper_posts.insert(who.to_string(), post);
        Ok(())
    }

    /// Permissionless from `odds_by`, or as soon as every keeper has posted.
    /// Accepts the quorum's median odds and opens the agents' window, or skips
    /// the request and refunds the fee when no quorum agrees.
    pub fn finalize_odds(
        &mut self,
        ledger: &mut Ledger,
        keepers: &Registry,
        now: u64,
        id: u32,
    ) -> Result<&Request, Error> {
        let window = self.config.forecast_window;
        let r = self.get_mut(id)?;
        if r.phase != Phase::Odds {
            return Err(Error::AlreadyFinalized);
        }
        let all_posted = keepers.keepers().all(|k| r.keeper_posts.contains_key(k));
        if now < r.odds_by && !all_posted {
            return Err(Error::PostingStillOpen);
        }
        let posts: BTreeMap<AccountId, Vec<MarketPost>> = std::mem::take(&mut r.keeper_posts)
            .into_iter()
            .map(|(k, p)| (k, vec![p]))
            .collect();
        let colony = r.colony;
        match accept(&posts, keepers.quorum(), |_| colony) {
            Ok(mut ms) => {
                r.market = ms.pop();
                r.forecast_by = Some(now.saturating_add(window));
                r.phase = Phase::Forecasting;
            }
            Err(Error::NoQuorum) | Err(Error::BadMarket) => {
                ledger.ft_transfer(REQUEST_ESCROW, &r.requester, r.fee)?;
                r.phase = Phase::Skipped;
            }
            Err(e) => return Err(e),
        }
        Ok(r)
    }

    /// Outcome count of request colony `colony` if its agents' window is open.
    pub fn forecast_window(&self, colony: u16, now: u64) -> Result<usize, Error> {
        let id = Self::id_of(colony).ok_or(Error::BadColony)?;
        let r = self.get(id).ok_or(Error::NoSuchRequest(id))?;
        match (r.phase, r.forecast_by, r.n_outcomes()) {
            (Phase::Forecasting, Some(by), Some(n)) if now < by => Ok(n),
            _ => Err(Error::PostingClosed),
        }
    }

    /// Stake on request colony `colony` while its agents' window is open.
    #[allow(clippy::too_many_arguments)]
    pub fn stake(
        &self,
        staking: &mut Staking,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        let n = self
            .forecast_window(colony, now)
            .map_err(|e| if e == Error::PostingClosed { Error::StakingClosed } else { e })?;
        if option as usize >= n {
            return Err(Error::BadOption);
        }
        staking.stake_request(ledger, now, who, colony, option, amount)
    }

    /// Withdraw from request colony `colony`, except from the end of its
    /// agents' window until its last colony has run.
    #[allow(clippy::too_many_arguments)]
    pub fn unstake(
        &self,
        staking: &mut Staking,
        ledger: &mut Ledger,
        now: u64,
        who: &str,
        colony: u16,
        option: u8,
        amount: u128,
    ) -> Result<(), Error> {
        let id = Self::id_of(colony).ok_or(Error::BadColony)?;
        let r = self.get(id).ok_or(Error::NoSuchRequest(id))?;
        let locked = match r.phase {
            Phase::Running => true,
            Phase::Forecasting => r.forecast_by.is_some_and(|by| now >= by),
            _ => false,
        };
        if locked {
            return Err(Error::Locked);
        }
        staking.unstake_request(ledger, now, who, colony, option, amount)
    }

    /// Permissionless once the agents' window has closed: run the next of the
    /// five colonies and pay `who` the crank bounty. The first call freezes
    /// the agent posts and the stakes and draws the seed from `entropy`; the
    /// fifth stores the market result and pays the fee out.
    #[allow(clippy::too_many_arguments)]
    pub fn crank(
        &mut self,
        ledger: &mut Ledger,
        agents: &mut Agents,
        staking: &Staking,
        now: u64,
        who: &str,
        id: u32,
        entropy: [u8; 32],
        contract: &str,
    ) -> Result<Crank, Error> {
        let cfg = self.config;
        let r = self.get_mut(id)?;
        let mut drew_seed = false;
        match r.phase {
            Phase::Forecasting => {
                if r.forecast_by.is_some_and(|by| now < by) {
                    return Err(Error::PostingStillOpen);
                }
                let n = r.n_outcomes().ok_or(Error::NotCrankable)?;
                r.agents = Some(agents.freeze(r.colony, n));
                let snap = staking.colony_snapshot(r.colony);
                r.stakes = Some(RequestStakes {
                    entries: snap.entries,
                    hash: snap.hash,
                    weights: staking.sim_weights(r.colony, n),
                });
                let mut buf = SEED_TAG.to_vec();
                buf.extend_from_slice(&entropy);
                buf.extend_from_slice(&id.to_be_bytes());
                buf.extend_from_slice(contract.as_bytes());
                r.seed = Some(sha256(&buf));
                r.phase = Phase::Running;
                drew_seed = true;
            }
            Phase::Running => {}
            _ => return Err(Error::NotCrankable),
        }
        let m = r.market.clone().ok_or(Error::NotCrankable)?;
        let ag = r.agents.clone().ok_or(Error::NotCrankable)?;
        let st = r.stakes.clone().ok_or(Error::NotCrankable)?;
        let seed = r.seed.ok_or(Error::NotCrankable)?;
        let k = r.runs.len();
        let kind = KINDS[k];
        let sim = forecast_run(
            &colony_seed(&seed, r.colony, kind as u8),
            kind,
            &m.odds,
            &m.odds_6h,
            &st.weights,
            st.hash,
            &ag.odds,
            ag.hash,
            FORECAST_ANTS,
            FORECAST_TICKS,
        )
        .map_err(|_| Error::BadMarket)?;
        let bounty = cfg.crank_bounty();
        if bounty > 0 {
            ledger.ft_transfer(REQUEST_ESCROW, who, bounty)?;
        }
        r.payouts.cranks.push((who.to_string(), bounty));
        let run_hash = sim.hash;
        r.runs.push(ColonyRun {
            hash: sim.hash,
            scores: sim.scores,
            perm: sim.perm,
            winner_source: sim.winner_source as u8,
            winner_option: sim.winner_option as u8,
            cranker: who.to_string(),
        });
        let done = r.runs.len() == CRANKS;
        if done {
            // Community counts if anyone staked, Agents if any agent posted.
            let counted = voters(&st.weights, &ag.odds);
            let out = market_result(
                r.colony,
                r.runs.iter().map(ColonyRun::sim).collect(),
                counted,
            )
            .map_err(|_| Error::BadMarket)?;
            r.swarm = Some(out.swarm);
            r.market_hash = Some(out.hash);
            r.payouts = pay_out(ledger, &cfg, &m, &ag, std::mem::take(&mut r.payouts))?;
            r.phase = Phase::Done;
        }
        Ok(Crank {
            kind: k,
            run_hash,
            bounty,
            drew_seed,
            done,
        })
    }
}

/// Split `share` equally over `who`, moving the tokens out of escrow.
fn split(
    ledger: &mut Ledger,
    share: u128,
    who: Vec<AccountId>,
) -> Result<Vec<(AccountId, u128)>, Error> {
    if who.is_empty() {
        return Ok(vec![]);
    }
    let each = share / who.len() as u128;
    let mut out = Vec::with_capacity(who.len());
    for a in who {
        if each > 0 {
            ledger.ft_transfer(REQUEST_ESCROW, &a, each)?;
        }
        out.push((a, each));
    }
    Ok(out)
}

/// Keepers in the accepted quorum and agents whose posts counted split their
/// shares equally; whatever is left of the fee is burned from escrow.
fn pay_out(
    ledger: &mut Ledger,
    cfg: &RequestConfig,
    m: &Market,
    ag: &AgentSnapshot,
    mut p: Payouts,
) -> Result<Payouts, Error> {
    let keepers = m.raw_hashes.iter().map(|(k, _)| k.clone()).collect();
    p.keepers = split(ledger, cfg.share(cfg.keeper_bps), keepers)?;
    let agents = ag.posts.iter().map(|(a, _)| a.clone()).collect();
    p.agents = split(ledger, cfg.share(cfg.agent_bps), agents)?;
    let paid: u128 = p
        .keepers
        .iter()
        .chain(&p.agents)
        .chain(&p.cranks)
        .map(|(_, v)| v)
        .sum();
    p.burned = cfg.fee - paid;
    if p.burned > 0 {
        ledger.burn(REQUEST_ESCROW, p.burned)?;
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agents::AGENT_VAULT,
        ledger::ONE,
        stake::{hash_entries, StakeConfig, VAULT},
    };

    /// Sample values; the real fee and split are still open.
    const CFG: RequestConfig = RequestConfig {
        fee: 100 * ONE,
        keeper_bps: 2_000,
        agent_bps: 3_000,
        crank_bps: 1_000,
        odds_window: 600_000,
        forecast_window: 1_800_000,
        agent_deposit: 10 * ONE,
    };
    const SLUG: &str = "fed-decision-in-december";
    const LATE: u64 = 9_000_000_000;

    fn post(odds: &[u16]) -> MarketPost {
        MarketPost {
            market_id: SLUG.into(),
            outcomes: ["Cut", "Hold", "Hike"][..odds.len()]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            odds: odds.to_vec(),
            odds_6h: odds.to_vec(),
            raw_hash: sha256(b"raw"),
        }
    }

    struct World {
        l: Ledger,
        reg: Registry,
        ag: Agents,
        st: Staking,
        rq: Requests,
    }

    fn world() -> World {
        let mut l = Ledger::new("t", 10_000 * ONE);
        for a in ["req", "a1", "a2", "a3"] {
            l.ft_transfer("t", a, 200 * ONE).unwrap();
        }
        World {
            l,
            reg: Registry::new(vec!["k1".into(), "k2".into(), "k3".into()], 2, 0).unwrap(),
            ag: Agents::default(),
            st: Staking::new(StakeConfig {
                cap_per_wallet: 100 * ONE,
                close_at: 10,
                publish_at: 20,
            })
            .unwrap(),
            rq: Requests::new(CFG).unwrap(),
        }
    }

    /// Request at t=0, two keepers agree, odds finalized at t=600_000.
    fn forecasting(w: &mut World) -> u32 {
        let id = w.rq.request(&mut w.l, 0, "req", SLUG).unwrap();
        w.rq.post_odds(&w.reg, 1, "k1", id, post(&[6200, 2800, 1000]))
            .unwrap();
        w.rq.post_odds(&w.reg, 1, "k2", id, post(&[6000, 3000, 1000]))
            .unwrap();
        w.rq.finalize_odds(&mut w.l, &w.reg, 600_000, id).unwrap();
        id
    }

    #[test]
    fn config_shares_must_fit_the_fee() {
        let bad = RequestConfig {
            keeper_bps: 9_000,
            agent_bps: 1_001,
            ..CFG
        };
        assert_eq!(Requests::new(bad).unwrap_err(), Error::BadRequestConfig);
        let free = RequestConfig { fee: 0, ..CFG };
        assert_eq!(Requests::new(free).unwrap_err(), Error::BadRequestConfig);
        assert_eq!(CFG.crank_bounty(), 2 * ONE);
    }

    #[test]
    fn request_escrows_the_fee_and_filters_the_slug() {
        let mut w = world();
        let id = w.rq.request(&mut w.l, 5, "req", SLUG).unwrap();
        assert_eq!((id, w.rq.get(id).unwrap().colony), (0, 0x8000));
        assert_eq!(w.l.ft_balance_of(REQUEST_ESCROW), 100 * ONE);
        assert_eq!(w.l.ft_balance_of("req"), 100 * ONE);
        assert_eq!(w.rq.get(id).unwrap().odds_by, 600_005);
        for bad in ["", "Fed-Decision", "fed decision", "fed_decision"] {
            assert_eq!(w.rq.request(&mut w.l, 5, "req", bad), Err(Error::BadMarket));
        }
        for denied in [
            "who-will-die-first",
            "missile-strikes-by-june",
            "war-by-2027",
        ] {
            assert_eq!(
                w.rq.request(&mut w.l, 5, "req", denied),
                Err(Error::DeniedMarket)
            );
        }
        // Whole words only for the exact entries: "warriors" is a team.
        assert!(!slug_denied("warriors-win-the-finals"));
        assert!(matches!(
            w.rq.request(&mut w.l, 5, "nobody", SLUG),
            Err(Error::InsufficientBalance { .. })
        ));
        assert_eq!(w.rq.count(), 1);
    }

    #[test]
    fn no_quorum_skips_and_refunds() {
        let mut w = world();
        let id = w.rq.request(&mut w.l, 0, "req", SLUG).unwrap();
        w.rq.post_odds(&w.reg, 1, "k1", id, post(&[6000, 3000, 1000]))
            .unwrap();
        assert_eq!(
            w.rq.finalize_odds(&mut w.l, &w.reg, 599_999, id)
                .unwrap_err(),
            Error::PostingStillOpen
        );
        let r = w.rq.finalize_odds(&mut w.l, &w.reg, 600_000, id).unwrap();
        assert_eq!(r.phase, Phase::Skipped);
        assert_eq!(w.l.ft_balance_of("req"), 200 * ONE);
        assert_eq!(w.l.ft_balance_of(REQUEST_ESCROW), 0);
        let crank = w.rq.crank(&mut w.l, &mut w.ag, &w.st, LATE, "c", id, [0; 32], "x");
        assert_eq!(crank.unwrap_err(), Error::NotCrankable);
    }

    #[test]
    fn keepers_post_only_while_open_and_for_this_market() {
        let mut w = world();
        let id = w.rq.request(&mut w.l, 0, "req", SLUG).unwrap();
        let p = post(&[6000, 4000]);
        assert_eq!(
            w.rq.post_odds(&w.reg, 1, "eve", id, p.clone()),
            Err(Error::NotKeeper)
        );
        let mut other = p.clone();
        other.market_id = "something-else".into();
        assert_eq!(
            w.rq.post_odds(&w.reg, 1, "k1", id, other),
            Err(Error::BadMarket)
        );
        assert_eq!(
            w.rq.post_odds(&w.reg, 600_000, "k1", id, p.clone()),
            Err(Error::PostingClosed)
        );
        assert_eq!(
            w.rq.post_odds(&w.reg, 1, "k1", 7, p),
            Err(Error::NoSuchRequest(7))
        );
    }

    #[test]
    fn every_keeper_posted_finalizes_early() {
        let mut w = world();
        let id = w.rq.request(&mut w.l, 0, "req", SLUG).unwrap();
        for k in ["k1", "k2", "k3"] {
            w.rq.post_odds(&w.reg, 1, k, id, post(&[6000, 4000]))
                .unwrap();
        }
        let r = w.rq.finalize_odds(&mut w.l, &w.reg, 2, id).unwrap();
        assert_eq!(r.phase, Phase::Forecasting);
        assert_eq!(r.forecast_by, Some(1_800_002));
        assert_eq!(r.market.as_ref().unwrap().colony, 0x8000);
        assert!(r.keeper_posts.is_empty());
    }

    #[test]
    fn full_lifecycle_runs_five_colonies_and_splits_the_fee() {
        let mut w = world();
        let id = forecasting(&mut w);
        let colony = w.rq.get(id).unwrap().colony;
        let n = w.rq.forecast_window(colony, 600_001).unwrap();
        assert_eq!(n, 3);
        for (a, o) in [
            ("a1", vec![5000, 4000, 1000]),
            ("a2", vec![4500, 4000, 1500]),
            ("a3", vec![3000, 5000, 2000]),
        ] {
            w.ag.register(&mut w.l, a, CFG.agent_deposit).unwrap();
            w.ag.post(a, colony, n, o).unwrap();
        }
        let close = 600_000 + CFG.forecast_window;
        assert_eq!(
            w.rq.forecast_window(colony, close),
            Err(Error::PostingClosed)
        );
        assert_eq!(
            w.rq.crank(
                &mut w.l,
                &mut w.ag,
                &w.st,
                close - 1,
                "c1",
                id,
                [7; 32],
                "anto.testnet"
            )
            .unwrap_err(),
            Error::PostingStillOpen
        );
        let supply = w.l.ft_total_supply();
        let mut cranks = vec![];
        for (i, who) in ["c1", "c2", "c1", "c1", "c2"].iter().enumerate() {
            let c =
                w.rq.crank(&mut w.l, &mut w.ag, &w.st, close, who, id, [7; 32], "anto.testnet")
                    .unwrap();
            assert_eq!((c.kind, c.drew_seed, c.done), (i, i == 0, i == 4));
            cranks.push(c);
        }
        let r = w.rq.get(id).unwrap().clone();
        assert_eq!(r.phase, Phase::Done);
        let ag = r.agents.as_ref().unwrap();
        assert_eq!(ag.odds, vec![4500, 4000, 1500]);
        let swarm = r.swarm.clone().unwrap();
        assert_eq!(swarm.iter().map(|&x| x as u32).sum::<u32>(), 10_000);

        // The stored result is exactly what the sim gives for the same inputs.
        let m = r.market.as_ref().unwrap();
        let st = r.stakes.as_ref().unwrap();
        assert_eq!((st.weights.clone(), st.hash), (vec![0, 0, 0], hash_entries(&[])));
        let again = antosim::forecast_market(
            &r.seed.unwrap(),
            colony,
            &m.odds,
            &m.odds_6h,
            &st.weights,
            st.hash,
            &ag.odds,
            ag.hash,
            FORECAST_ANTS,
            FORECAST_TICKS,
        )
        .unwrap();
        assert_eq!(r.market_hash, Some(again.hash));
        assert_eq!(swarm, again.swarm);
        let run_hashes: Vec<_> = cranks.iter().map(|c| c.run_hash).collect();
        let want: Vec<_> = again.colonies.iter().map(|c| c.hash).collect();
        assert_eq!(run_hashes, want);

        // Fee 100: keepers 20 over k1, k2; agents 30 over three; cranks 2 a call.
        let p = &r.payouts;
        assert_eq!(
            p.keepers,
            vec![("k1".into(), 10 * ONE), ("k2".into(), 10 * ONE)]
        );
        let agent_pay: Vec<u128> = p.agents.iter().map(|x| x.1).collect();
        assert_eq!(agent_pay, vec![10 * ONE; 3]);
        assert_eq!(p.cranks.len(), 5);
        assert_eq!(w.l.ft_balance_of("c1"), 6 * ONE);
        assert_eq!(w.l.ft_balance_of("c2"), 4 * ONE);
        assert_eq!(p.burned, 40 * ONE);
        assert_eq!(w.l.ft_total_supply(), supply - 40 * ONE);
        assert_eq!(w.l.ft_balance_of(REQUEST_ESCROW), 0);
        assert_eq!(w.l.ft_balance_of(AGENT_VAULT), 30 * ONE);
        assert_eq!(
            w.rq.crank(&mut w.l, &mut w.ag, &w.st, close, "c1", id, [7; 32], "x")
                .unwrap_err(),
            Error::NotCrankable
        );
    }

    #[test]
    fn no_agents_burns_their_share_and_dust() {
        let mut w = world();
        // Three keepers agree: 20 over three leaves dust for the burn.
        let id = w.rq.request(&mut w.l, 0, "req", SLUG).unwrap();
        for k in ["k1", "k2", "k3"] {
            w.rq.post_odds(&w.reg, 1, k, id, post(&[7000, 3000]))
                .unwrap();
        }
        w.rq.finalize_odds(&mut w.l, &w.reg, 1, id).unwrap();
        let close = 1 + CFG.forecast_window;
        for _ in 0..CRANKS {
            w.rq.crank(&mut w.l, &mut w.ag, &w.st, close, "c", id, [1; 32], "x")
                .unwrap();
        }
        let r = w.rq.get(id).unwrap();
        assert_eq!(r.agents.as_ref().unwrap().hash, [0; 32]);
        let each = 20 * ONE / 3;
        assert!(r.payouts.keepers.iter().all(|(_, v)| *v == each));
        assert!(r.payouts.agents.is_empty());
        assert_eq!(r.payouts.burned, 100 * ONE - 3 * each - 10 * ONE);
        assert_eq!(w.l.ft_balance_of(REQUEST_ESCROW), 0);
    }

    #[test]
    fn seed_depends_on_entropy_id_and_contract() {
        let seed = |entropy, contract: &str| {
            let mut w = world();
            let id = forecasting(&mut w);
            w.rq.crank(&mut w.l, &mut w.ag, &w.st, LATE, "c", id, entropy, contract)
                .unwrap();
            w.rq.get(id).unwrap().seed.unwrap()
        };
        let base = seed([1; 32], "a");
        assert_eq!(base, seed([1; 32], "a"));
        assert_ne!(base, seed([2; 32], "a"));
        assert_ne!(base, seed([1; 32], "b"));
    }

    #[test]
    fn agents_window_belongs_to_request_colonies() {
        let mut w = world();
        let id = forecasting(&mut w);
        assert_eq!(Requests::id_of(0x8000 + id as u16), Some(id));
        assert_eq!(Requests::id_of(1), None);
        assert_eq!(w.rq.forecast_window(1, 0), Err(Error::BadColony));
        assert_eq!(
            w.rq.forecast_window(0x8005, 0),
            Err(Error::NoSuchRequest(5))
        );
    }

    #[test]
    fn stakes_ride_the_agents_window_and_feed_community() {
        let mut w = world();
        let id = forecasting(&mut w);
        let colony = w.rq.get(id).unwrap().colony;
        let close = 600_000 + CFG.forecast_window;
        // The round's own staking has closed (t >= 10): requests keep their clock.
        w.rq.stake(&mut w.st, &mut w.l, 600_001, "a1", colony, 2, 36 * ONE)
            .unwrap();
        w.rq.stake(&mut w.st, &mut w.l, 600_001, "a2", colony, 0, 9 * ONE)
            .unwrap();
        assert_eq!(
            w.rq.stake(&mut w.st, &mut w.l, 600_001, "a3", colony, 3, ONE),
            Err(Error::BadOption)
        );
        assert_eq!(
            w.st.stake(&mut w.l, 0, "a3", colony, 0, ONE),
            Err(Error::BadColony),
            "request colonies only stake through their request"
        );
        // Withdraw while open, then not from the window's end until done.
        w.rq.unstake(&mut w.st, &mut w.l, 600_002, "a2", colony, 0, 5 * ONE)
            .unwrap();
        assert_eq!(
            w.rq.stake(&mut w.st, &mut w.l, close, "a3", colony, 0, ONE),
            Err(Error::StakingClosed)
        );
        assert_eq!(
            w.rq.unstake(&mut w.st, &mut w.l, close, "a1", colony, 2, ONE),
            Err(Error::Locked)
        );
        // Request stakes stay out of the round's snapshot.
        assert!(w.st.snapshot(close).unwrap().entries.is_empty());
        w.rq.crank(&mut w.l, &mut w.ag, &w.st, close, "c", id, [3; 32], "x")
            .unwrap();
        assert_eq!(
            w.rq.unstake(&mut w.st, &mut w.l, close, "a1", colony, 2, ONE),
            Err(Error::Locked)
        );
        for _ in 1..CRANKS {
            w.rq.crank(&mut w.l, &mut w.ag, &w.st, close, "c", id, [3; 32], "x")
                .unwrap();
        }
        let r = w.rq.get(id).unwrap().clone();
        let st = r.stakes.as_ref().unwrap();
        assert_eq!(
            st.entries,
            vec![
                ("a1".into(), colony, 2, 36 * ONE),
                ("a2".into(), colony, 0, 4 * ONE)
            ]
        );
        assert_eq!(st.weights, vec![2_000, 0, 6_000]);
        assert_eq!(st.hash, hash_entries(&st.entries));
        let m = r.market.as_ref().unwrap();
        let ag = r.agents.as_ref().unwrap();
        let again = antosim::forecast_market(
            &r.seed.unwrap(),
            colony,
            &m.odds,
            &m.odds_6h,
            &st.weights,
            st.hash,
            &ag.odds,
            ag.hash,
            FORECAST_ANTS,
            FORECAST_TICKS,
        )
        .unwrap();
        assert_eq!(r.market_hash, Some(again.hash));
        assert_eq!(r.swarm.as_ref(), Some(&again.swarm));
        // Community voted: the belief isn't the three odds colonies' mean.
        let three = antosim::market_result(
            colony,
            again.colonies.clone(),
            [true, true, true, false, false],
        )
        .unwrap();
        assert_ne!(three.hash, again.hash);
        // Done: stakers withdraw, and the request pays them nothing.
        w.rq.unstake(&mut w.st, &mut w.l, close, "a1", colony, 2, 36 * ONE)
            .unwrap();
        w.rq.unstake(&mut w.st, &mut w.l, close, "a2", colony, 0, 4 * ONE)
            .unwrap();
        assert_eq!(w.l.ft_balance_of("a1"), 200 * ONE);
        assert_eq!(w.l.ft_balance_of(VAULT), 0);
    }

    #[test]
    fn request_stakes_survive_the_next_round() {
        let mut w = world();
        let id = forecasting(&mut w);
        let colony = w.rq.get(id).unwrap().colony;
        w.rq.stake(&mut w.st, &mut w.l, 600_001, "a1", colony, 1, 4 * ONE)
            .unwrap();
        let next = StakeConfig {
            cap_per_wallet: 100 * ONE,
            close_at: 700_000,
            publish_at: 800_000,
        };
        assert!(w.st.reopen(&mut w.l, next).unwrap().is_empty());
        assert_eq!(w.st.stakes_of("a1"), vec![(colony, 1, 4 * ONE)]);
        assert_eq!(
            w.rq.stake(&mut w.st, &mut w.l, 600_001, "a1", 0x8009, 0, ONE),
            Err(Error::NoSuchRequest(9))
        );
    }
}
