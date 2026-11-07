//! Forecaster agents (Recruit the swarm). An agent registers with a refundable
//! $ANTO deposit as a spam guard, then posts its own odds for a market's
//! colony from any model it likes. When the market's window closes, the posts
//! of agents still registered are frozen into the agent-odds snapshot: the
//! per-outcome lower median, which feeds the Agents colony, and a hash of every
//! post, which goes into that colony's result hash.
//!
//! Agents are paid for posting on time, out of a requested market's fee
//! (`request`), never for being right.
//!
//! Hidden, then shown (docs/FORECAST_QUALITY.md §3): an agent first commits a
//! hash of its odds and a secret salt, and reveals them in the window's last
//! third (`reveal`), so no agent can copy another's odds. The colony reads a
//! skill-weighted lower median: each agent's weight comes from its scored
//! record (`score::agent_weight`), 1000 for an agent with none. With equal
//! weights the median, and the snapshot hash, are exactly the unweighted ones.
//! Sybil resistance is unsolved: the deposit makes spam cost something, it
//! does not stop one owner from running many agents.

use crate::{ledger::AccountId, ledger::Ledger, market::median, Error};
use antosim::sha256;
use std::collections::BTreeMap;

/// Account that holds the registration deposits.
pub const AGENT_VAULT: &str = "agent-vault.antonomy";
pub const AGENTS_TAG: &[u8] = b"ANTO-AGENTS-v0";
pub const COMMIT_TAG: &[u8] = b"ANTO-COMMIT-v0";
const BPS: u32 = 10_000;
/// Longest account id NEAR allows; the hash stores the length in one byte.
const MAX_ACCOUNT_LEN: usize = 64;

/// The frozen agent posts of one colony.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct AgentSnapshot {
    /// Per-outcome lower median, the Agents colony's food. All zeros (an even
    /// map) when no agent posted.
    pub odds: Vec<u16>,
    /// sha256 over every post; 32 zero bytes when no agent posted.
    pub hash: [u8; 32],
    /// (agent, odds) sorted by agent: the posts that counted.
    pub posts: Vec<(AccountId, Vec<u16>)>,
}

/// sha256(tag, colony u16, n u8, odds u16 each, salt 32 bytes, account bytes):
/// what `commit_forecast` stores and `reveal_forecast` checks.
pub fn commit_hash(colony: u16, odds: &[u16], salt: &[u8; 32], who: &str) -> [u8; 32] {
    let mut buf = COMMIT_TAG.to_vec();
    buf.extend_from_slice(&colony.to_be_bytes());
    buf.push(odds.len() as u8);
    for o in odds {
        buf.extend_from_slice(&o.to_be_bytes());
    }
    buf.extend_from_slice(salt);
    buf.extend_from_slice(who.as_bytes());
    sha256(&buf)
}

fn all_equal(w: &[u16]) -> bool {
    w.windows(2).all(|p| p[0] == p[1])
}

/// Weighted lower median: the posted values sorted, then the first one where
/// the weight so far, doubled, reaches the total. With equal weights this is
/// the lower median. Weights must not all be zero.
pub fn weighted_median(values: &[u16], weights: &[u16]) -> u16 {
    let mut vw: Vec<(u16, u64)> = values
        .iter()
        .zip(weights)
        .map(|(&v, &w)| (v, w as u64))
        .collect();
    vw.sort_unstable();
    let total: u64 = vw.iter().map(|x| x.1).sum();
    let mut seen = 0;
    for (v, w) in &vw {
        seen += w;
        if 2 * seen >= total {
            return *v;
        }
    }
    vw[vw.len() - 1].0
}

/// sha256(tag, n u8, count u16, then per post sorted by account: account
/// length u8, account bytes, n odds as u16). Zero bytes for no posts.
pub fn snapshot_hash(n: usize, posts: &[(AccountId, Vec<u16>)]) -> [u8; 32] {
    weighted_snapshot_hash(n, posts, &[])
}

/// `snapshot_hash`, then each post's weight (u16, in post order) when the
/// weights are not all equal.
pub fn weighted_snapshot_hash(n: usize, posts: &[(AccountId, Vec<u16>)], weights: &[u16]) -> [u8; 32] {
    if posts.is_empty() {
        return [0; 32];
    }
    let mut buf = AGENTS_TAG.to_vec();
    buf.push(n as u8);
    buf.extend_from_slice(&(posts.len() as u16).to_be_bytes());
    for (who, odds) in posts {
        buf.push(who.len() as u8);
        buf.extend_from_slice(who.as_bytes());
        for o in odds {
            buf.extend_from_slice(&o.to_be_bytes());
        }
    }
    if !all_equal(weights) {
        for w in weights {
            buf.extend_from_slice(&w.to_be_bytes());
        }
    }
    sha256(&buf)
}

#[derive(Debug, Clone, Default)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Agents {
    /// Registered agents and the deposit each one holds in the vault.
    registered: BTreeMap<AccountId, u128>,
    /// Open posts per colony: agent -> odds. Removed when frozen.
    posts: BTreeMap<u16, BTreeMap<AccountId, Vec<u16>>>,
}

impl Agents {
    /// Move `deposit` from `who` into the vault. Registering twice fails.
    pub fn register(&mut self, ledger: &mut Ledger, who: &str, deposit: u128) -> Result<(), Error> {
        if self.registered.contains_key(who) {
            return Err(Error::AlreadyRegistered);
        }
        if who.is_empty() || who.len() > MAX_ACCOUNT_LEN {
            return Err(Error::NotAgent);
        }
        if deposit > 0 {
            ledger.ft_transfer(who, AGENT_VAULT, deposit)?;
        }
        self.registered.insert(who.to_string(), deposit);
        Ok(())
    }

    /// Refund the deposit. Open posts stay stored but no longer count.
    pub fn unregister(&mut self, ledger: &mut Ledger, who: &str) -> Result<u128, Error> {
        let deposit = *self.registered.get(who).ok_or(Error::NotAgent)?;
        if deposit > 0 {
            ledger.ft_transfer(AGENT_VAULT, who, deposit)?;
        }
        self.registered.remove(who);
        Ok(deposit)
    }

    pub fn is_registered(&self, who: &str) -> bool {
        self.registered.contains_key(who)
    }

    pub fn deposit_of(&self, who: &str) -> Option<u128> {
        self.registered.get(who).copied()
    }

    pub fn registered(&self) -> impl Iterator<Item = &AccountId> {
        self.registered.keys()
    }

    /// Post or replace `who`'s odds for `colony`, a market with `n` outcomes.
    /// The caller checks the colony's posting window. Odds must sum to 10000.
    pub fn post(&mut self, who: &str, colony: u16, n: usize, odds: Vec<u16>) -> Result<(), Error> {
        if !self.is_registered(who) {
            return Err(Error::NotAgent);
        }
        let sum: u32 = odds.iter().map(|&o| o as u32).sum();
        if odds.len() != n || !(2..=5).contains(&n) || sum != BPS {
            return Err(Error::BadForecast);
        }
        self.posts
            .entry(colony)
            .or_default()
            .insert(who.to_string(), odds);
        Ok(())
    }

    /// Open posts for `colony`, sorted by agent.
    pub fn posts_of(&self, colony: u16) -> Vec<(AccountId, Vec<u16>)> {
        self.posts
            .get(&colony)
            .map(|m| m.iter().map(|(a, o)| (a.clone(), o.clone())).collect())
            .unwrap_or_default()
    }

    /// Reveal a committed forecast: `committed` is the hash `who` committed
    /// for `colony`. The odds are then posted as with `post`.
    #[allow(clippy::too_many_arguments)]
    pub fn reveal(
        &mut self,
        who: &str,
        colony: u16,
        n: usize,
        odds: Vec<u16>,
        salt: &[u8; 32],
        committed: Option<[u8; 32]>,
    ) -> Result<(), Error> {
        let c = committed.ok_or(Error::NoCommit)?;
        if commit_hash(colony, &odds, salt, who) != c {
            return Err(Error::BadReveal);
        }
        self.post(who, colony, n, odds)
    }

    /// What the snapshot would be if `colony` froze now (agents still
    /// registered only), with every agent weighing the same. Read-only.
    pub fn preview(&self, colony: u16, n: usize) -> AgentSnapshot {
        self.preview_weighted(colony, n, &|_| 1000).0
    }

    /// The snapshot with each agent weighted by `weight`, and those weights
    /// in post order.
    pub fn preview_weighted(
        &self,
        colony: u16,
        n: usize,
        weight: &dyn Fn(&str) -> u16,
    ) -> (AgentSnapshot, Vec<u16>) {
        let posts: Vec<(AccountId, Vec<u16>)> = self
            .posts_of(colony)
            .into_iter()
            .filter(|(a, o)| self.is_registered(a) && o.len() == n)
            .collect();
        let weights: Vec<u16> = posts.iter().map(|(a, _)| weight(a)).collect();
        let odds = if posts.is_empty() {
            vec![0; n]
        } else if all_equal(&weights) {
            (0..n)
                .map(|i| median(posts.iter().map(|(_, o)| o[i]).collect()))
                .collect()
        } else {
            (0..n)
                .map(|i| {
                    let vals: Vec<u16> = posts.iter().map(|(_, o)| o[i]).collect();
                    weighted_median(&vals, &weights)
                })
                .collect()
        };
        let snap = AgentSnapshot {
            hash: weighted_snapshot_hash(n, &posts, &weights),
            odds,
            posts,
        };
        (snap, weights)
    }

    /// Drop the open posts of the round's markets (colonies below the request
    /// range), when a new round starts. Posts on requested markets stay.
    pub fn clear_round(&mut self) {
        self.posts
            .retain(|c, _| *c >= crate::request::REQUEST_COLONY_BASE);
    }

    /// Freeze `colony`'s posts into its snapshot and drop them from storage.
    pub fn freeze(&mut self, colony: u16, n: usize) -> AgentSnapshot {
        self.freeze_weighted(colony, n, &|_| 1000).0
    }

    /// `freeze` with each agent weighted by `weight`; also returns the weights.
    pub fn freeze_weighted(
        &mut self,
        colony: u16,
        n: usize,
        weight: &dyn Fn(&str) -> u16,
    ) -> (AgentSnapshot, Vec<u16>) {
        let out = self.preview_weighted(colony, n, weight);
        self.posts.remove(&colony);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ONE;

    fn setup() -> (Ledger, Agents) {
        let mut l = Ledger::new("t", 1_000 * ONE);
        for a in ["a1.testnet", "b2.testnet", "c3.testnet"] {
            l.ft_transfer("t", a, 50 * ONE).unwrap();
        }
        (l, Agents::default())
    }

    #[test]
    fn snapshot_matches_the_shared_vector() {
        // Same vector as web/test_agents.mjs.
        let (mut l, mut ag) = setup();
        for (a, o) in [
            ("c3.testnet", vec![3000, 3000, 4000]),
            ("a1.testnet", vec![6000, 3000, 1000]),
            ("b2.testnet", vec![5000, 4000, 1000]),
        ] {
            ag.register(&mut l, a, 10 * ONE).unwrap();
            ag.post(a, 0x8000, 3, o).unwrap();
        }
        let s = ag.freeze(0x8000, 3);
        assert_eq!(s.odds, vec![5000, 3000, 1000]);
        assert_eq!(
            crate::stake::hash_hex(&s.hash),
            "b04dce28ad9489ae08cc9860c154b76b4b1d7394607b719b803822e25d4b7821"
        );
        assert_eq!(s.posts[0].0, "a1.testnet");
        assert!(ag.posts_of(0x8000).is_empty());
    }

    #[test]
    fn weighted_median_follows_the_weight() {
        let v = [3000, 5000, 6000];
        assert_eq!(weighted_median(&v, &[1000, 1000, 1000]), 5000);
        assert_eq!(weighted_median(&v, &[4000, 1000, 1000]), 3000);
        assert_eq!(weighted_median(&v, &[250, 250, 4000]), 6000);
        // Equal weights give the lower median for even counts too.
        assert_eq!(weighted_median(&[1, 2, 3, 4], &[7; 4]), 2);
        assert_eq!(weighted_median(&[9], &[1]), 9);
    }

    #[test]
    fn equal_weights_keep_the_old_snapshot_and_skill_moves_it() {
        let (mut l, mut ag) = setup();
        for (a, o) in [
            ("c3.testnet", vec![3000, 3000, 4000]),
            ("a1.testnet", vec![6000, 3000, 1000]),
            ("b2.testnet", vec![5000, 4000, 1000]),
        ] {
            ag.register(&mut l, a, 10 * ONE).unwrap();
            ag.post(a, 0x8000, 3, o).unwrap();
        }
        let (eq, w) = ag.preview_weighted(0x8000, 3, &|_| 1000);
        assert_eq!(w, vec![1000; 3]);
        assert_eq!(eq, ag.preview(0x8000, 3));
        assert_eq!(
            crate::stake::hash_hex(&eq.hash),
            "b04dce28ad9489ae08cc9860c154b76b4b1d7394607b719b803822e25d4b7821"
        );
        // c3 has the record: its odds lead.
        let (sk, w) = ag.freeze_weighted(0x8000, 3, &|a| if a == "c3.testnet" { 4000 } else { 1000 });
        assert_eq!(w, vec![1000, 1000, 4000]);
        assert_eq!(sk.odds, vec![3000, 3000, 4000]);
        assert_ne!(sk.hash, eq.hash);
        // The shared vector for web/agents.mjs.
        assert_eq!(
            crate::stake::hash_hex(&sk.hash),
            "3daf27ecc89cba6a784c616e40c16dd6b6052954ed0a59ff7f8b502a57f63cb2"
        );
    }

    #[test]
    fn reveal_needs_the_committed_odds_and_salt() {
        let (mut l, mut ag) = setup();
        ag.register(&mut l, "a1.testnet", ONE).unwrap();
        let salt = [9u8; 32];
        let c = commit_hash(1, &[7000, 3000], &salt, "a1.testnet");
        assert_eq!(
            ag.reveal("a1.testnet", 1, 2, vec![7000, 3000], &salt, None),
            Err(Error::NoCommit)
        );
        assert_eq!(
            ag.reveal("a1.testnet", 1, 2, vec![6000, 4000], &salt, Some(c)),
            Err(Error::BadReveal)
        );
        assert_eq!(
            ag.reveal("a1.testnet", 1, 2, vec![7000, 3000], &[8; 32], Some(c)),
            Err(Error::BadReveal)
        );
        // Another agent can't reveal someone else's commit as its own.
        ag.register(&mut l, "b2.testnet", ONE).unwrap();
        assert_eq!(
            ag.reveal("b2.testnet", 1, 2, vec![7000, 3000], &salt, Some(c)),
            Err(Error::BadReveal)
        );
        ag.reveal("a1.testnet", 1, 2, vec![7000, 3000], &salt, Some(c)).unwrap();
        assert_eq!(ag.preview(1, 2).odds, vec![7000, 3000]);
        // The shared vector for web/agents.mjs and bots/recruit.py.
        assert_eq!(
            crate::stake::hash_hex(&c),
            "5fb2951fc420fe264f4375b17870f73825aac178e29c1819ccd17f276f47b6c8"
        );
    }

    #[test]
    fn no_posts_means_an_even_map_and_a_zero_hash() {
        let (_, mut ag) = setup();
        let s = ag.freeze(1, 2);
        assert_eq!((s.odds, s.hash, s.posts.len()), (vec![0, 0], [0; 32], 0));
    }

    #[test]
    fn deposit_is_held_and_refunded() {
        let (mut l, mut ag) = setup();
        ag.register(&mut l, "a1.testnet", 10 * ONE).unwrap();
        assert_eq!(l.ft_balance_of("a1.testnet"), 40 * ONE);
        assert_eq!(l.ft_balance_of(AGENT_VAULT), 10 * ONE);
        assert_eq!(
            ag.register(&mut l, "a1.testnet", 10 * ONE),
            Err(Error::AlreadyRegistered)
        );
        assert_eq!(ag.unregister(&mut l, "a1.testnet"), Ok(10 * ONE));
        assert_eq!(l.ft_balance_of("a1.testnet"), 50 * ONE);
        assert_eq!(ag.unregister(&mut l, "a1.testnet"), Err(Error::NotAgent));
    }

    #[test]
    fn only_registered_agents_post_and_only_they_count() {
        let (mut l, mut ag) = setup();
        assert_eq!(
            ag.post("a1.testnet", 1, 2, vec![5000, 5000]),
            Err(Error::NotAgent)
        );
        ag.register(&mut l, "a1.testnet", ONE).unwrap();
        ag.register(&mut l, "b2.testnet", ONE).unwrap();
        ag.post("a1.testnet", 1, 2, vec![7000, 3000]).unwrap();
        ag.post("b2.testnet", 1, 2, vec![2000, 8000]).unwrap();
        // A repost replaces the earlier one.
        ag.post("a1.testnet", 1, 2, vec![6000, 4000]).unwrap();
        ag.unregister(&mut l, "b2.testnet").unwrap();
        let s = ag.preview(1, 2);
        assert_eq!(s.odds, vec![6000, 4000]);
        assert_eq!(s.posts.len(), 1);
    }

    #[test]
    fn forecasts_must_be_whole_and_fit_the_market() {
        let (mut l, mut ag) = setup();
        ag.register(&mut l, "a1.testnet", ONE).unwrap();
        for odds in [vec![5000, 4999], vec![10000], vec![2000; 6], vec![10001, 0]] {
            let n = odds.len();
            assert_eq!(ag.post("a1.testnet", 1, n, odds), Err(Error::BadForecast));
        }
        assert_eq!(
            ag.post("a1.testnet", 1, 3, vec![5000, 5000]),
            Err(Error::BadForecast)
        );
    }
}
