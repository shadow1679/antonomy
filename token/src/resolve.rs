//! Market resolutions, posted by the same keepers as the odds and accepted
//! under the same quorum (docs/FORECAST_QUALITY.md §1). Each keeper posts a
//! market's state, the winning outcome's label once resolved, and the end
//! date, with a hash of the raw API response. A resolution is accepted when
//! `quorum` keepers posted the same (state, winner, end date). Once a final
//! state (resolved, fifty_fifty) is accepted it never changes.

use crate::{ledger::AccountId, market::MAX_ID_LEN, market::MAX_LABEL_LEN, Error};
use std::collections::BTreeMap;

pub const OPEN: u8 = 0;
/// An outcome was proposed and the challenge period is running.
pub const PROPOSED: u8 = 1;
pub const DISPUTED: u8 = 2;
pub const RESOLVED: u8 = 3;
/// Resolved with every outcome paid evenly (Polymarket's 50-50).
pub const FIFTY_FIFTY: u8 = 4;

pub fn is_final(state: u8) -> bool {
    state == RESOLVED || state == FIFTY_FIFTY
}

/// One keeper's read of one market.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct ResolutionPost {
    pub market_id: String,
    pub state: u8,
    /// The winning outcome's label when `state` is RESOLVED, else empty.
    pub winner: String,
    /// When the market is scheduled to end, Unix ms (0 if unknown).
    pub end_ms: u64,
    pub raw_hash: [u8; 32],
}

/// The accepted resolution of one market.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Resolution {
    pub state: u8,
    pub winner: String,
    pub end_ms: u64,
    /// (keeper, raw response hash) for each keeper that agreed.
    pub raw_hashes: Vec<(AccountId, [u8; 32])>,
}

pub fn check_post(p: &ResolutionPost) -> Result<(), Error> {
    let winner_ok = if p.state == RESOLVED {
        !p.winner.is_empty() && p.winner.len() <= MAX_LABEL_LEN
    } else {
        p.winner.is_empty()
    };
    if p.market_id.is_empty() || p.market_id.len() > MAX_ID_LEN || p.state > FIFTY_FIFTY || !winner_ok {
        return Err(Error::BadResolution);
    }
    Ok(())
}

/// The resolution `quorum` keepers agree on, if any. Keepers post one
/// resolution each per market and `quorum` is a strict majority, so at most
/// one group can reach it.
pub fn accept(posts: &BTreeMap<AccountId, ResolutionPost>, quorum: u8) -> Option<Resolution> {
    let mut groups: BTreeMap<(u8, &str, u64), Vec<&AccountId>> = BTreeMap::new();
    for (who, p) in posts {
        groups
            .entry((p.state, p.winner.as_str(), p.end_ms))
            .or_default()
            .push(who);
    }
    let ((state, winner, end_ms), keepers) = groups
        .into_iter()
        .find(|(_, g)| g.len() >= quorum as usize)?;
    Some(Resolution {
        state,
        winner: winner.to_string(),
        end_ms,
        raw_hashes: keepers
            .into_iter()
            .map(|k| (k.clone(), posts[k].raw_hash))
            .collect(),
    })
}

/// Store `who`'s post and return the newly accepted resolution, if the
/// accepted one changed. `current` is the accepted resolution so far; a final
/// one can't be changed.
pub fn post(
    posts: &mut BTreeMap<AccountId, ResolutionPost>,
    current: Option<&Resolution>,
    quorum: u8,
    who: &str,
    p: ResolutionPost,
) -> Result<Option<Resolution>, Error> {
    check_post(&p)?;
    if current.is_some_and(|r| is_final(r.state)) {
        return Err(Error::AlreadyResolved);
    }
    posts.insert(who.to_string(), p);
    Ok(accept(posts, quorum).filter(|r| current != Some(r)))
}

/// The resolution as basis points per outcome: 10000 on the winner (or on
/// "Other" when the winner was folded into it), or an even split for
/// fifty_fifty, the remainder on the first outcome. `None` when the market
/// isn't final or the winner isn't among `outcomes` (the book is void).
pub fn outcome_vector(r: &Resolution, outcomes: &[String]) -> Option<Vec<u16>> {
    let n = outcomes.len();
    match r.state {
        FIFTY_FIFTY => {
            let mut y = vec![(10_000 / n) as u16; n];
            y[0] += (10_000 % n) as u16;
            Some(y)
        }
        RESOLVED => {
            let i = outcomes
                .iter()
                .position(|o| *o == r.winner)
                .or_else(|| outcomes.iter().position(|o| o == "Other"))?;
            let mut y = vec![0; n];
            y[i] = 10_000;
            Some(y)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(state: u8, winner: &str, end: u64) -> ResolutionPost {
        ResolutionPost {
            market_id: "fed-decision".into(),
            state,
            winner: winner.into(),
            end_ms: end,
            raw_hash: [state; 32],
        }
    }

    #[test]
    fn needs_a_quorum_of_the_same_read() {
        let mut posts = BTreeMap::new();
        assert_eq!(post(&mut posts, None, 2, "k1", p(OPEN, "", 9)), Ok(None));
        // A different end date is a different read.
        assert_eq!(post(&mut posts, None, 2, "k2", p(OPEN, "", 8)), Ok(None));
        let r = post(&mut posts, None, 2, "k3", p(OPEN, "", 9)).unwrap().unwrap();
        assert_eq!((r.state, r.end_ms, r.raw_hashes.len()), (OPEN, 9, 2));
        assert_eq!(r.raw_hashes[0].0, "k1");
        // Repeating an accepted read changes nothing.
        assert_eq!(post(&mut posts, Some(&r), 2, "k1", p(OPEN, "", 9)), Ok(None));
    }

    #[test]
    fn final_resolutions_stick() {
        let mut posts = BTreeMap::new();
        post(&mut posts, None, 2, "k1", p(RESOLVED, "Cut", 9)).unwrap();
        let r = post(&mut posts, None, 2, "k2", p(RESOLVED, "Cut", 9)).unwrap().unwrap();
        assert!(is_final(r.state));
        assert_eq!(
            post(&mut posts, Some(&r), 2, "k3", p(DISPUTED, "", 9)),
            Err(Error::AlreadyResolved)
        );
    }

    #[test]
    fn winner_only_when_resolved() {
        assert_eq!(check_post(&p(RESOLVED, "", 0)), Err(Error::BadResolution));
        assert_eq!(check_post(&p(OPEN, "Cut", 0)), Err(Error::BadResolution));
        assert_eq!(check_post(&p(FIFTY_FIFTY + 1, "", 0)), Err(Error::BadResolution));
        assert_eq!(check_post(&p(FIFTY_FIFTY, "", 0)), Ok(()));
    }

    #[test]
    fn outcome_vectors() {
        let labels: Vec<String> = ["Cut", "Hold", "Other"].map(String::from).to_vec();
        let res = |state, w: &str| Resolution {
            state,
            winner: w.into(),
            end_ms: 0,
            raw_hashes: vec![],
        };
        assert_eq!(outcome_vector(&res(RESOLVED, "Hold"), &labels), Some(vec![0, 10_000, 0]));
        // A winner folded into "Other".
        assert_eq!(outcome_vector(&res(RESOLVED, "Hike"), &labels), Some(vec![0, 0, 10_000]));
        assert_eq!(outcome_vector(&res(FIFTY_FIFTY, ""), &labels), Some(vec![3334, 3333, 3333]));
        assert_eq!(outcome_vector(&res(RESOLVED, "Hike"), &labels[..2]), None);
        assert_eq!(outcome_vector(&res(PROPOSED, ""), &labels), None);
    }
}
