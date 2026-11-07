//! The scorebook and market resolutions on chain (docs/FORECAST_QUALITY.md
//! §1 and §2). Everything lives under its own storage keys, outside the
//! `Contract` struct, so a code-only redeploy over live state is untouched:
//!
//! - `res-p:<market id>`: the keepers' resolution posts; `res:<market id>`:
//!   the accepted resolution.
//! - `bk:<book id>`, `bk-ids:<market id>`, `bk-a:<book id><agent>`,
//!   `bk-w:<book id><wallet>`: the books and their participants.
//! - `bk-open`: market ids with a book not yet scored, oldest first.
//! - `sc-tally`, `sc-a:<agent>`, `sc-w:<wallet>`: the scores.

use crate::{read_borsh, write_borsh};
use antotoken::{
    agents::AgentSnapshot,
    antosim::trail_shares,
    ledger::AccountId,
    market::Market,
    request::ColonyRun,
    resolve::{Resolution, ResolutionPost},
    score::{self, Book, Forecast, PairAcc, SkillTally, Store, Tally, WalletAcc},
    Error,
};
use std::collections::BTreeMap;

const OPEN_KEY: &[u8] = b"bk-open";
const TALLY_KEY: &[u8] = b"sc-tally";

fn key(prefix: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut k = prefix.to_vec();
    for p in parts {
        k.extend_from_slice(p);
    }
    k
}

/// The scorebook in contract storage.
pub struct ChainStore;

impl Store for ChainStore {
    fn book(&self, id: &[u8; 32]) -> Option<Book> {
        read_borsh(&key(b"bk:", &[id]))
    }
    fn set_book(&mut self, id: &[u8; 32], b: &Book) {
        write_borsh(&key(b"bk:", &[id]), b);
    }
    fn book_ids(&self, market_id: &str) -> Vec<[u8; 32]> {
        read_borsh(&key(b"bk-ids:", &[market_id.as_bytes()])).unwrap_or_default()
    }
    fn set_book_ids(&mut self, market_id: &str, ids: &[[u8; 32]]) {
        write_borsh(&key(b"bk-ids:", &[market_id.as_bytes()]), &ids.to_vec());
        let mut open = open_books();
        if !open.iter().any(|m| m == market_id) {
            open.push(market_id.to_string());
            write_borsh(OPEN_KEY, &open);
        }
    }
    fn agent_acc(&self, book: &[u8; 32], who: &str) -> Option<PairAcc> {
        read_borsh(&key(b"bk-a:", &[book, who.as_bytes()]))
    }
    fn set_agent_acc(&mut self, book: &[u8; 32], who: &str, a: &PairAcc) {
        write_borsh(&key(b"bk-a:", &[book, who.as_bytes()]), a);
    }
    fn wallet_acc(&self, book: &[u8; 32], who: &str) -> Option<WalletAcc> {
        read_borsh(&key(b"bk-w:", &[book, who.as_bytes()]))
    }
    fn set_wallet_acc(&mut self, book: &[u8; 32], who: &str, a: &WalletAcc) {
        write_borsh(&key(b"bk-w:", &[book, who.as_bytes()]), a);
    }
    fn tally(&self) -> Tally {
        read_borsh(TALLY_KEY).unwrap_or_default()
    }
    fn set_tally(&mut self, t: &Tally) {
        write_borsh(TALLY_KEY, t);
    }
    fn agent_tally(&self, who: &str) -> Option<SkillTally> {
        read_borsh(&key(b"sc-a:", &[who.as_bytes()]))
    }
    fn set_agent_tally(&mut self, who: &str, t: &SkillTally) {
        write_borsh(&key(b"sc-a:", &[who.as_bytes()]), t);
    }
    fn wallet_tally(&self, who: &str) -> Option<SkillTally> {
        read_borsh(&key(b"sc-w:", &[who.as_bytes()]))
    }
    fn set_wallet_tally(&mut self, who: &str, t: &SkillTally) {
        write_borsh(&key(b"sc-w:", &[who.as_bytes()]), t);
    }
}

/// Market ids with a book still waiting for its resolution, oldest first.
pub fn open_books() -> Vec<String> {
    read_borsh(OPEN_KEY).unwrap_or_default()
}

/// Add a market's finished forecast (its three runs, its swarm belief) to
/// its book. `wallets` are the staking wallets of the market's colony.
pub fn record_market(
    m: &Market,
    runs: &[ColonyRun],
    counted: [bool; 3],
    swarm: &[u16],
    agents: &AgentSnapshot,
    wallets: &[(AccountId, Vec<u32>)],
) -> Result<(), Error> {
    let shares: Vec<Vec<u16>> = runs.iter().map(|r| trail_shares(&r.sim())).collect();
    score::record(
        &mut ChainStore,
        &Forecast {
            market_id: &m.market_id,
            outcomes: &m.outcomes,
            odds: &m.odds,
            shares: &shares,
            counted,
            swarm,
            agents: &agents.posts,
            wallets,
        },
    )
}

pub fn resolution(market_id: &str) -> Option<Resolution> {
    read_borsh(&key(b"res:", &[market_id.as_bytes()]))
}

pub fn resolution_posts(market_id: &str) -> BTreeMap<AccountId, ResolutionPost> {
    read_borsh(&key(b"res-p:", &[market_id.as_bytes()])).unwrap_or_default()
}

/// Store a keeper's post; returns the newly accepted resolution, if any.
pub fn post_resolution(quorum: u8, who: &str, p: ResolutionPost) -> Result<Option<Resolution>, Error> {
    let id = p.market_id.clone();
    let mut posts = resolution_posts(&id);
    let current = resolution(&id);
    let accepted = antotoken::resolve::post(&mut posts, current.as_ref(), quorum, who, p)?;
    write_borsh(&key(b"res-p:", &[id.as_bytes()]), &posts);
    if let Some(r) = &accepted {
        write_borsh(&key(b"res:", &[id.as_bytes()]), r);
    }
    Ok(accepted)
}

/// Score a market's books against its final resolution and drop it from the
/// open list.
pub fn score_market(market_id: &str) -> Result<score::Scored, Error> {
    let r = resolution(market_id).ok_or(Error::NotResolved)?;
    let done = score::score(&mut ChainStore, market_id, &r)?;
    let mut open = open_books();
    open.retain(|m| m != market_id);
    write_borsh(OPEN_KEY, &open);
    Ok(done)
}

// ---- what the scorebook lends a forecast (docs/FORECAST_QUALITY.md §3, §4) ----
//
// - `cw-r:<round u64>`, `cw-q:<request id u32>`: the colonies' weights in the
//   swarm belief, frozen when the round or request froze its inputs; absent
//   means equal (rounds and requests from before the scorebook).
// - `agw:<agent snapshot hash>`: each post's weight in the Agents colony's
//   median, kept only when they are not all equal.
// - `cm:<colony u16>`: the agents' commits for an open colony, dropped when
//   the colony freezes.

pub fn agent_weight(who: &str) -> u16 {
    score::agent_weight(ChainStore.agent_tally(who).as_ref())
}

pub fn wallet_mult(who: &str) -> u16 {
    score::wallet_mult(ChainStore.wallet_tally(who).as_ref())
}

pub fn colony_weights() -> [u16; 3] {
    score::colony_weights(&ChainStore.tally())
}

fn round_weights_key(round: u64) -> Vec<u8> {
    key(b"cw-r:", &[&round.to_be_bytes()])
}

fn request_weights_key(id: u32) -> Vec<u8> {
    key(b"cw-q:", &[&id.to_be_bytes()])
}

pub fn save_round_weights(round: u64, w: [u16; 3]) {
    write_borsh(&round_weights_key(round), &w);
}

pub fn round_weights(round: u64) -> [u16; 3] {
    read_borsh(&round_weights_key(round)).unwrap_or([score::EQUAL; 3])
}

pub fn save_request_weights(id: u32, w: [u16; 3]) {
    write_borsh(&request_weights_key(id), &w);
}

pub fn request_weights(id: u32) -> [u16; 3] {
    read_borsh(&request_weights_key(id)).unwrap_or([score::EQUAL; 3])
}

/// Keep a frozen snapshot's agent weights, if they are not all equal (with
/// equal weights the snapshot is exactly the unweighted one).
pub fn save_agent_weights(snap: &AgentSnapshot) {
    let w: Vec<u16> = snap.posts.iter().map(|(a, _)| agent_weight(a)).collect();
    if w.windows(2).any(|p| p[0] != p[1]) {
        write_borsh(&key(b"agw:", &[&snap.hash]), &w);
    }
}

/// A snapshot's agent weights, or `None` when they were all equal.
pub fn agent_weights(hash: &[u8; 32]) -> Option<Vec<u16>> {
    read_borsh(&key(b"agw:", &[hash]))
}

fn commits_key(colony: u16) -> Vec<u8> {
    key(b"cm:", &[&colony.to_be_bytes()])
}

pub fn commits(colony: u16) -> BTreeMap<AccountId, [u8; 32]> {
    read_borsh(&commits_key(colony)).unwrap_or_default()
}

pub fn set_commits(colony: u16, c: &BTreeMap<AccountId, [u8; 32]>) {
    write_borsh(&commits_key(colony), c);
}

pub fn clear_commits(colony: u16) {
    near_sdk::env::storage_remove(&commits_key(colony));
}

// ---- the odds 1 hour and 24 hours ago (docs/FORECAST_QUALITY.md §5) ----
//
// Kept apart from the stored markets so their layout stays the same:
// - `mx-p:<keeper>`: each keeper's windows for its trending list, one per
//   market in list order (`None` where it posted none);
// - `mx-r:<round u64>`: the accepted windows of a round's markets;
// - `mx-qp:<request id u32><keeper>`, `mx-q:<request id u32>`: the same for a
//   requested market.

use antotoken::market::{median_windows, OddsWindows};

pub fn set_keeper_windows(keeper: &str, ws: &[Option<OddsWindows>]) {
    write_borsh(&key(b"mx-p:", &[keeper.as_bytes()]), &ws.to_vec());
}

/// Accept the windows of every market of a round, from the keepers whose
/// list was accepted.
pub fn accept_round_windows(round: u64, markets: &[Market]) {
    let ws: Vec<Option<OddsWindows>> = markets
        .iter()
        .enumerate()
        .map(|(i, m)| {
            median_windows(m, &|k| {
                read_borsh::<Vec<Option<OddsWindows>>>(&key(b"mx-p:", &[k.as_bytes()]))
                    .and_then(|v| v.get(i).cloned().flatten())
            })
        })
        .collect();
    write_borsh(&key(b"mx-r:", &[&round.to_be_bytes()]), &ws);
}

pub fn round_windows(round: u64) -> Vec<Option<OddsWindows>> {
    read_borsh(&key(b"mx-r:", &[&round.to_be_bytes()])).unwrap_or_default()
}

pub fn set_request_keeper_windows(id: u32, keeper: &str, w: &Option<OddsWindows>) {
    write_borsh(&key(b"mx-qp:", &[&id.to_be_bytes(), keeper.as_bytes()]), w);
}

pub fn accept_request_windows(id: u32, m: &Market) {
    let w = median_windows(m, &|k| {
        read_borsh::<Option<OddsWindows>>(&key(b"mx-qp:", &[&id.to_be_bytes(), k.as_bytes()])).flatten()
    });
    write_borsh(&key(b"mx-q:", &[&id.to_be_bytes()]), &w);
}

pub fn request_windows(id: u32) -> Option<OddsWindows> {
    read_borsh::<Option<OddsWindows>>(&key(b"mx-q:", &[&id.to_be_bytes()])).flatten()
}
