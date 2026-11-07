//! Forecast market registry. Allow-listed keepers each post the round's
//! trending list: the markets in rank order, with outcomes, odds now and six
//! hours ago (basis points) and a hash of the raw API response they read.
//! After posting closes, `finalize` accepts the list once at least `quorum`
//! keepers posted the same markets with the same outcomes, and takes the
//! per-outcome median of their odds. The sim reads those medians.
//!
//! Trust: the keepers are still trusted. Agreement only stops one keeper from
//! choosing the list or moving the odds alone. `quorum` must be a strict
//! majority, so at most one list can reach it.
//!
//! Trending (design doc section 15): active markets sorted by 24-hour volume,
//! after volume, liquidity, end-date and content filters. Keepers apply that
//! off-chain (`keeper/trending.py`); the contract only checks agreement.

use crate::{ledger::AccountId, Error};
use antosim::{market_colony, odds_richness, odds_snapshot_hash, Kind};
use std::collections::{BTreeMap, BTreeSet};

/// Markets per round. One for now; raise it once gas per market is measured.
pub const MAX_TRENDING: usize = 1;
pub const MAX_ID_LEN: usize = 128;
pub const MAX_LABEL_LEN: usize = 64;

/// One market as a keeper read it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct MarketPost {
    /// Polymarket event or market id.
    pub market_id: String,
    /// 2 to 5 labels, in the keeper's canonical order ("Other" last if grouped).
    pub outcomes: Vec<String>,
    pub odds: Vec<u16>,
    pub odds_6h: Vec<u16>,
    /// sha256 of the raw API responses this post was built from.
    pub raw_hash: [u8; 32],
}

/// A market accepted for the round.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Market {
    /// Colony id of this market's forecasters, and the staking colony id that
    /// sways its Community forecaster.
    pub colony: u16,
    pub market_id: String,
    pub outcomes: Vec<String>,
    /// Per-outcome median over the agreeing keepers.
    pub odds: Vec<u16>,
    pub odds_6h: Vec<u16>,
    /// The odds snapshot hash every forecaster of this market commits to.
    pub odds_hash: [u8; 32],
    /// (keeper, raw response hash) for each keeper whose list was accepted.
    pub raw_hashes: Vec<(AccountId, [u8; 32])>,
}

#[derive(Debug, Clone)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Registry {
    keepers: BTreeSet<AccountId>,
    quorum: u8,
    /// Posting allowed while `now < close_at`; same close as staking.
    close_at: u64,
    posts: BTreeMap<AccountId, Vec<MarketPost>>,
    markets: Option<Vec<Market>>,
}

/// What two keepers must agree on: the ordered markets and their outcomes.
fn list_key(list: &[MarketPost]) -> Vec<(&str, &[String])> {
    list.iter()
        .map(|m| (m.market_id.as_str(), m.outcomes.as_slice()))
        .collect()
}

/// Lower median: always one of the posted values.
fn median(mut xs: Vec<u16>) -> u16 {
    xs.sort_unstable();
    xs[(xs.len() - 1) / 2]
}

/// The odds must give every forecaster a usable map: at least one outcome
/// above 0 (Follower) and one below 10000 (Contrarian).
fn check_odds(odds: &[u16], odds_6h: &[u16]) -> Result<(), Error> {
    odds_richness(Kind::Follower, odds, odds_6h).map_err(|_| Error::BadMarket)?;
    odds_richness(Kind::Contrarian, odds, odds_6h).map_err(|_| Error::BadMarket)?;
    Ok(())
}

fn check_post(m: &MarketPost) -> Result<(), Error> {
    let label_ok = |s: &String| !s.is_empty() && s.len() <= MAX_LABEL_LEN;
    let distinct = m.outcomes.iter().collect::<BTreeSet<_>>().len() == m.outcomes.len();
    if m.market_id.is_empty()
        || m.market_id.len() > MAX_ID_LEN
        || !m.outcomes.iter().all(label_ok)
        || !distinct
        || m.odds.len() != m.outcomes.len()
    {
        return Err(Error::BadMarket);
    }
    check_odds(&m.odds, &m.odds_6h)
}

impl Registry {
    pub fn new(keepers: Vec<AccountId>, quorum: u8, close_at: u64) -> Result<Registry, Error> {
        let n = keepers.len();
        let keepers: BTreeSet<AccountId> = keepers.into_iter().collect();
        // Strict majority, so two different lists cannot both reach quorum.
        if keepers.len() != n || n == 0 || (quorum as usize) * 2 <= n || quorum as usize > n {
            return Err(Error::BadKeeperConfig);
        }
        Ok(Registry {
            keepers,
            quorum,
            close_at,
            posts: BTreeMap::new(),
            markets: None,
        })
    }

    pub fn keepers(&self) -> impl Iterator<Item = &AccountId> {
        self.keepers.iter()
    }

    pub fn quorum(&self) -> u8 {
        self.quorum
    }

    /// Post or replace this keeper's list for the round.
    pub fn post(&mut self, now: u64, who: &str, list: Vec<MarketPost>) -> Result<(), Error> {
        if !self.keepers.contains(who) {
            return Err(Error::NotKeeper);
        }
        if now >= self.close_at || self.markets.is_some() {
            return Err(Error::PostingClosed);
        }
        if list.is_empty() || list.len() > MAX_TRENDING {
            return Err(Error::BadMarket);
        }
        let ids: BTreeSet<&str> = list.iter().map(|m| m.market_id.as_str()).collect();
        if ids.len() != list.len() {
            return Err(Error::BadMarket);
        }
        list.iter().try_for_each(check_post)?;
        self.posts.insert(who.to_string(), list);
        Ok(())
    }

    pub fn post_of(&self, who: &str) -> Option<&[MarketPost]> {
        self.posts.get(who).map(Vec::as_slice)
    }

    /// Permissionless once posting has closed. Accepts the list that at least
    /// `quorum` keepers posted and stores the per-outcome medians. Fails with
    /// `NoQuorum` if no list reached it; the round then runs without forecasts.
    pub fn finalize(&mut self, now: u64) -> Result<&[Market], Error> {
        if now < self.close_at {
            return Err(Error::PostingStillOpen);
        }
        if self.markets.is_some() {
            return Err(Error::AlreadyFinalized);
        }
        // Group keepers by the list they posted. BTreeMap keeps it deterministic.
        let mut groups: BTreeMap<Vec<(&str, &[String])>, Vec<&AccountId>> = BTreeMap::new();
        for (who, list) in &self.posts {
            groups.entry(list_key(list)).or_default().push(who);
        }
        let agreeing = groups
            .into_values()
            .find(|g| g.len() >= self.quorum as usize)
            .ok_or(Error::NoQuorum)?;

        let first = &self.posts[agreeing[0]];
        let mut markets = Vec::with_capacity(first.len());
        for (m, post) in first.iter().enumerate() {
            let posts: Vec<&MarketPost> = agreeing.iter().map(|k| &self.posts[*k][m]).collect();
            let med = |f: fn(&MarketPost) -> &[u16]| -> Vec<u16> {
                (0..post.outcomes.len())
                    .map(|o| median(posts.iter().map(|p| f(p)[o]).collect()))
                    .collect()
            };
            let odds = med(|p| &p.odds);
            let odds_6h = med(|p| &p.odds_6h);
            // Each post was valid, but a median of valid posts can still be all zeros.
            check_odds(&odds, &odds_6h)?;
            markets.push(Market {
                colony: market_colony(m as u16),
                market_id: post.market_id.clone(),
                outcomes: post.outcomes.clone(),
                odds_hash: odds_snapshot_hash(&odds, &odds_6h).map_err(|_| Error::BadMarket)?,
                odds,
                odds_6h,
                raw_hashes: agreeing
                    .iter()
                    .zip(&posts)
                    .map(|(k, p)| ((*k).clone(), p.raw_hash))
                    .collect(),
            });
        }
        Ok(self.markets.insert(markets).as_slice())
    }

    /// The accepted markets, once finalized.
    pub fn markets(&self) -> Option<&[Market]> {
        self.markets.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(id: &str, odds: &[u16], odds_6h: &[u16]) -> MarketPost {
        let labels = ["Yes", "No", "Maybe", "Later", "Other"];
        MarketPost {
            market_id: id.into(),
            outcomes: labels[..odds.len()].iter().map(|s| s.to_string()).collect(),
            odds: odds.to_vec(),
            odds_6h: odds_6h.to_vec(),
            raw_hash: antosim::sha256(id.as_bytes()),
        }
    }

    fn reg() -> Registry {
        Registry::new(vec!["k1".into(), "k2".into(), "k3".into()], 2, 100).unwrap()
    }

    #[test]
    fn config_needs_a_strict_majority() {
        let ks = |n: usize| (0..n).map(|i| format!("k{i}")).collect::<Vec<_>>();
        assert!(Registry::new(ks(3), 2, 1).is_ok());
        assert!(Registry::new(ks(1), 1, 1).is_ok());
        assert_eq!(
            Registry::new(ks(4), 2, 1).unwrap_err(),
            Error::BadKeeperConfig
        );
        assert_eq!(
            Registry::new(ks(3), 4, 1).unwrap_err(),
            Error::BadKeeperConfig
        );
        assert_eq!(
            Registry::new(vec![], 0, 1).unwrap_err(),
            Error::BadKeeperConfig
        );
        let dup = vec!["k".to_string(), "k".to_string(), "j".to_string()];
        assert_eq!(
            Registry::new(dup, 2, 1).unwrap_err(),
            Error::BadKeeperConfig
        );
    }

    #[test]
    fn median_of_agreeing_keepers() {
        let mut r = reg();
        r.post(1, "k1", vec![post("m1", &[6000, 4000], &[5000, 5000])])
            .unwrap();
        r.post(2, "k2", vec![post("m1", &[6400, 3600], &[5200, 4800])])
            .unwrap();
        r.post(3, "k3", vec![post("m1", &[6200, 3900], &[4000, 6000])])
            .unwrap();
        let ms = r.finalize(100).unwrap();
        assert_eq!(ms.len(), 1);
        let m = &ms[0];
        assert_eq!(m.colony, 1);
        assert_eq!(m.odds, vec![6200, 3900]);
        assert_eq!(m.odds_6h, vec![5000, 5000]);
        assert_eq!(
            m.odds_hash,
            odds_snapshot_hash(&m.odds, &m.odds_6h).unwrap()
        );
        assert_eq!(m.raw_hashes.len(), 3);
        assert_eq!(r.finalize(100).unwrap_err(), Error::AlreadyFinalized);
    }

    #[test]
    fn even_count_takes_the_lower_median() {
        let mut r = reg();
        r.post(1, "k1", vec![post("m1", &[7000, 3000], &[7000, 3000])])
            .unwrap();
        r.post(1, "k3", vec![post("m1", &[6000, 4000], &[6000, 4000])])
            .unwrap();
        assert_eq!(r.finalize(100).unwrap()[0].odds, vec![6000, 3000]);
    }

    #[test]
    fn a_lone_keeper_cannot_choose_the_list() {
        let mut r = reg();
        r.post(1, "k1", vec![post("m1", &[6000, 4000], &[6000, 4000])])
            .unwrap();
        r.post(1, "k2", vec![post("m2", &[6000, 4000], &[6000, 4000])])
            .unwrap();
        assert_eq!(r.finalize(100).unwrap_err(), Error::NoQuorum);
        // The odd keeper out is ignored once two agree.
        let mut r = reg();
        r.post(1, "k1", vec![post("m1", &[6000, 4000], &[6000, 4000])])
            .unwrap();
        r.post(1, "k2", vec![post("m2", &[9000, 1000], &[6000, 4000])])
            .unwrap();
        r.post(1, "k3", vec![post("m1", &[5000, 5000], &[6000, 4000])])
            .unwrap();
        let m = &r.finalize(100).unwrap()[0];
        assert_eq!(m.market_id, "m1");
        assert_eq!(m.odds, vec![5000, 4000]);
        assert_eq!(
            m.raw_hashes
                .iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>(),
            ["k1", "k3"]
        );
    }

    #[test]
    fn outcomes_must_match_too() {
        let mut r = reg();
        let mut other = post("m1", &[6000, 4000], &[6000, 4000]);
        other.outcomes = vec!["No".into(), "Yes".into()];
        r.post(1, "k1", vec![post("m1", &[6000, 4000], &[6000, 4000])])
            .unwrap();
        r.post(1, "k2", vec![other]).unwrap();
        assert_eq!(r.finalize(100).unwrap_err(), Error::NoQuorum);
    }

    #[test]
    fn repost_replaces_and_timing_is_enforced() {
        let mut r = reg();
        r.post(1, "k1", vec![post("m1", &[6000, 4000], &[6000, 4000])])
            .unwrap();
        r.post(2, "k1", vec![post("m2", &[6000, 4000], &[6000, 4000])])
            .unwrap();
        assert_eq!(r.post_of("k1").unwrap()[0].market_id, "m2");
        assert_eq!(r.finalize(99).unwrap_err(), Error::PostingStillOpen);
        let late = r.post(100, "k2", vec![post("m2", &[6000, 4000], &[6000, 4000])]);
        assert_eq!(late.unwrap_err(), Error::PostingClosed);
    }

    #[test]
    fn rejects_outsiders_and_bad_posts() {
        let mut r = reg();
        let ok = || post("m1", &[6000, 4000], &[6000, 4000]);
        assert_eq!(r.post(1, "eve", vec![ok()]).unwrap_err(), Error::NotKeeper);
        let bad = |r: &mut Registry, list| r.post(1, "k1", list).unwrap_err();
        assert_eq!(bad(&mut r, vec![]), Error::BadMarket);
        assert_eq!(
            bad(&mut r, vec![ok(), post("m2", &[1, 1], &[1, 1])]),
            Error::BadMarket
        );
        assert_eq!(
            bad(&mut r, vec![post("m1", &[0, 0], &[0, 0])]),
            Error::BadMarket
        );
        assert_eq!(
            bad(&mut r, vec![post("m1", &[10000, 10000], &[0, 0])]),
            Error::BadMarket
        );
        assert_eq!(
            bad(&mut r, vec![post("m1", &[10001, 0], &[0, 0])]),
            Error::BadMarket
        );
        assert_eq!(
            bad(&mut r, vec![post("m1", &[5000], &[5000])]),
            Error::BadMarket
        );
        let mut dup = ok();
        dup.outcomes[1] = "Yes".into();
        assert_eq!(bad(&mut r, vec![dup]), Error::BadMarket);
        let mut long = ok();
        long.market_id = "x".repeat(MAX_ID_LEN + 1);
        assert_eq!(bad(&mut r, vec![long]), Error::BadMarket);
        let mut short = ok();
        short.odds_6h.pop();
        assert_eq!(bad(&mut r, vec![short]), Error::BadMarket);
    }

    #[test]
    fn median_that_is_all_zero_fails_finalize() {
        let mut r = reg();
        r.post(1, "k1", vec![post("m1", &[100, 0, 0], &[1, 1, 1])])
            .unwrap();
        r.post(1, "k2", vec![post("m1", &[0, 100, 0], &[1, 1, 1])])
            .unwrap();
        r.post(1, "k3", vec![post("m1", &[0, 0, 100], &[1, 1, 1])])
            .unwrap();
        assert_eq!(r.finalize(100).unwrap_err(), Error::BadMarket);
        assert!(r.markets().is_none());
    }

    #[test]
    fn accepted_market_runs_the_forecast() {
        let mut r = reg();
        r.post(
            1,
            "k1",
            vec![post("m1", &[6200, 2800, 1000], &[5500, 3300, 1200])],
        )
        .unwrap();
        r.post(
            1,
            "k2",
            vec![post("m1", &[6200, 2800, 1000], &[5500, 3300, 1200])],
        )
        .unwrap();
        let m = r.finalize(100).unwrap()[0].clone();
        let seed = antosim::seed_from_int(0);
        let out = antosim::forecast_market(
            &seed,
            m.colony,
            &m.odds,
            &m.odds_6h,
            &[3000, 0, 12000],
            antosim::sha256(b"stakes"),
            antosim::FORECAST_ANTS,
            antosim::FORECAST_TICKS,
        )
        .unwrap();
        // Same fixture as sim/rust forecast_market_matches_reference.
        assert_eq!(out.swarm, vec![3594, 3121, 3285]);
    }
}
