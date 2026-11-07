//! Scorebook (docs/FORECAST_QUALITY.md §2 to §4). Every finished forecast is
//! added to its market's book; when the market resolves, every source is
//! scored by its time-averaged Brier score and by its skill: the market's own
//! Brier score minus the source's, over the same forecasts. A source that
//! copies the market has skill 0. Skill sets the agents' weights in the
//! Agents colony, the wallets' weights in the Community colony and the
//! colonies' weights in the swarm belief. It never moves money.
//!
//! Books are keyed by (market id, outcome labels) and hold running sums of p
//! and p² per outcome, so a book's size stays fixed however many rounds the
//! market ran in. Storage goes through `Store`; the contract keeps each item
//! under its own key so the contract state's layout doesn't change.

use crate::{
    ledger::AccountId,
    resolve::{is_final, outcome_vector, Resolution, FIFTY_FIFTY},
    Error,
};
use antosim::sha256;

pub const BOOK_TAG: &[u8] = b"ANTO-BOOK-v0";
const BPS: u64 = 10_000;

/// The sources of a book, in this order.
pub const MARKET: usize = 0;
pub const MOMENTUM: usize = 1;
pub const COMMUNITY: usize = 2;
pub const AGENTS: usize = 3;
pub const SWARM: usize = 4;
pub const N_SOURCES: usize = 5;

/// Agents and wallets recorded per book; later ones aren't scored there.
pub const MAX_PARTICIPANTS: usize = 50;
/// Colony weights stay equal until this many books are scored.
pub const MIN_SCORED: u32 = 20;
/// The weight of a colony, agent or wallet with no record.
pub const EQUAL: u16 = 1000;

/// Running sums of one forecaster's forecasts on one book.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Acc {
    pub count: u32,
    pub sum: Vec<u64>,
    pub sq: Vec<u64>,
}

impl Acc {
    pub fn new(n: usize) -> Acc {
        Acc {
            count: 0,
            sum: vec![0; n],
            sq: vec![0; n],
        }
    }

    pub fn add(&mut self, p: &[u16]) {
        self.count += 1;
        for (o, &x) in p.iter().enumerate() {
            self.sum[o] += x as u64;
            self.sq[o] += x as u64 * x as u64;
        }
    }

    /// Mean Brier score of the forecasts against `y`, in 1/10000 of Brier
    /// (0 to 20000), floored; `None` with no forecasts. Exact from the sums:
    /// Σ_t Σ_o (p − y)² = Σ_o (Σp² − 2·y·Σp + T·y²).
    pub fn brier(&self, y: &[u16]) -> Option<u64> {
        if self.count == 0 {
            return None;
        }
        let t = self.count as i128;
        let total: i128 = y
            .iter()
            .enumerate()
            .map(|(o, &yo)| {
                let yo = yo as i128;
                self.sq[o] as i128 - 2 * yo * self.sum[o] as i128 + t * yo * yo
            })
            .sum();
        Some((total / (t * BPS as i128)) as u64)
    }
}

/// A source's forecasts and the market's, on the rounds the source counted.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct PairAcc {
    pub own: Acc,
    pub market: Acc,
}

impl PairAcc {
    pub fn new(n: usize) -> PairAcc {
        PairAcc {
            own: Acc::new(n),
            market: Acc::new(n),
        }
    }

    fn add(&mut self, p: &[u16], m: &[u16]) {
        self.own.add(p);
        self.market.add(m);
    }

    /// (own Brier, the market's Brier on the same forecasts).
    pub fn briers(&self, y: &[u16]) -> Option<(u64, u64)> {
        Some((self.own.brier(y)?, self.market.brier(y)?))
    }
}

/// One wallet's sugar on one book: per outcome, A = Σ sqrt-stake and
/// B = Σ sqrt-stake × the market's odds (bps).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct WalletAcc {
    pub stake: Vec<u64>,
    pub at_market: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Book {
    pub market_id: String,
    pub outcomes: Vec<String>,
    /// One per source, in `MARKET..SWARM` order.
    pub src: Vec<PairAcc>,
    pub agents: Vec<AccountId>,
    pub wallets: Vec<AccountId>,
    pub scored: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct SrcTally {
    /// Books where the source forecast at least once.
    pub count: u32,
    pub brier_sum: u64,
    /// The market's Brier on the same forecasts.
    pub market_sum: u64,
    /// Σ (market Brier − own Brier).
    pub skill_sum: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct Tally {
    /// Books scored.
    pub books: u32,
    /// Books whose market resolved 50-50: counted, not scored
    /// (docs/FORECAST_PAGE.md §5).
    pub fifty_fifty: u32,
    /// Resolved books whose winner wasn't among their outcomes: not scored.
    pub void: u32,
    pub src: Vec<SrcTally>,
}

impl Default for Tally {
    fn default() -> Tally {
        Tally {
            books: 0,
            fifty_fifty: 0,
            void: 0,
            src: vec![SrcTally::default(); N_SOURCES],
        }
    }
}

/// An agent's or a wallet's record: markets scored and Σ skill (agents, in
/// 1/10000 of Brier) or Σ edge (wallets, in basis points).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct SkillTally {
    pub markets: u32,
    pub sum: i64,
}

/// Where the scorebook lives. The contract keeps each item under its own key.
pub trait Store {
    fn book(&self, id: &[u8; 32]) -> Option<Book>;
    fn set_book(&mut self, id: &[u8; 32], b: &Book);
    fn book_ids(&self, market_id: &str) -> Vec<[u8; 32]>;
    fn set_book_ids(&mut self, market_id: &str, ids: &[[u8; 32]]);
    fn agent_acc(&self, book: &[u8; 32], who: &str) -> Option<PairAcc>;
    fn set_agent_acc(&mut self, book: &[u8; 32], who: &str, a: &PairAcc);
    fn wallet_acc(&self, book: &[u8; 32], who: &str) -> Option<WalletAcc>;
    fn set_wallet_acc(&mut self, book: &[u8; 32], who: &str, a: &WalletAcc);
    fn tally(&self) -> Tally;
    fn set_tally(&mut self, t: &Tally);
    fn agent_tally(&self, who: &str) -> Option<SkillTally>;
    fn set_agent_tally(&mut self, who: &str, t: &SkillTally);
    fn wallet_tally(&self, who: &str) -> Option<SkillTally>;
    fn set_wallet_tally(&mut self, who: &str, t: &SkillTally);
}

/// sha256(tag, id length u8, id, n u8, then per label: length u8, label).
pub fn book_id(market_id: &str, outcomes: &[String]) -> [u8; 32] {
    let mut buf = BOOK_TAG.to_vec();
    buf.push(market_id.len() as u8);
    buf.extend_from_slice(market_id.as_bytes());
    buf.push(outcomes.len() as u8);
    for o in outcomes {
        buf.push(o.len() as u8);
        buf.extend_from_slice(o.as_bytes());
    }
    sha256(&buf)
}

/// Odds scaled to sum to 10000: floored, the remainder on the largest
/// (lowest index on ties). The keepers' per-outcome medians needn't sum to
/// 10000; at least one is above zero (`market::check_odds`).
pub fn normalize(odds: &[u16]) -> Vec<u16> {
    let total: u64 = odds.iter().map(|&o| o as u64).sum();
    let mut out: Vec<u16> = odds
        .iter()
        .map(|&o| (o as u64 * BPS / total.max(1)) as u16)
        .collect();
    let top = (0..odds.len()).fold(0, |t, o| if odds[o] > odds[t] { o } else { t });
    out[top] += (BPS - out.iter().map(|&x| x as u64).sum::<u64>()) as u16;
    out
}

/// One finished forecast of one market.
pub struct Forecast<'a> {
    pub market_id: &'a str,
    pub outcomes: &'a [String],
    /// The keepers' median odds the colonies read.
    pub odds: &'a [u16],
    /// The three colonies' trail shares, in `KINDS` order.
    pub shares: &'a [Vec<u16>],
    pub counted: [bool; 3],
    pub swarm: &'a [u16],
    /// The agents' posts that counted.
    pub agents: &'a [(AccountId, Vec<u16>)],
    /// Each staking wallet's sqrt-stake per outcome (milli sqrt-tokens).
    pub wallets: &'a [(AccountId, Vec<u32>)],
}

/// Add a finished forecast to its book. A book that is already scored takes
/// no more forecasts.
pub fn record(s: &mut impl Store, f: &Forecast) -> Result<(), Error> {
    let n = f.outcomes.len();
    let well_formed = f.odds.len() == n
        && f.swarm.len() == n
        && f.shares.len() == 3
        && f.shares.iter().all(|x| x.len() == n)
        && f.agents.iter().all(|(_, p)| p.len() == n)
        && f.wallets.iter().all(|(_, w)| w.len() == n);
    if !(2..=5).contains(&n) || !well_formed {
        return Err(Error::BadMarket);
    }
    let id = book_id(f.market_id, f.outcomes);
    let mut book = match s.book(&id) {
        Some(b) => b,
        None => {
            let mut ids = s.book_ids(f.market_id);
            ids.push(id);
            s.set_book_ids(f.market_id, &ids);
            Book {
                market_id: f.market_id.to_string(),
                outcomes: f.outcomes.to_vec(),
                src: vec![PairAcc::new(n); N_SOURCES],
                agents: vec![],
                wallets: vec![],
                scored: false,
            }
        }
    };
    if book.scored {
        return Ok(());
    }
    let m = normalize(f.odds);
    book.src[MARKET].add(&m, &m);
    for k in 0..3 {
        if f.counted[k] {
            book.src[MOMENTUM + k].add(&f.shares[k], &m);
        }
    }
    book.src[SWARM].add(f.swarm, &m);

    for (who, p) in f.agents {
        let acc = match s.agent_acc(&id, who) {
            Some(a) => Some(a),
            None if book.agents.len() < MAX_PARTICIPANTS => {
                book.agents.push(who.clone());
                Some(PairAcc::new(n))
            }
            None => None,
        };
        if let Some(mut acc) = acc {
            acc.add(p, &m);
            s.set_agent_acc(&id, who, &acc);
        }
    }
    for (who, w) in f.wallets {
        if w.iter().all(|&x| x == 0) {
            continue;
        }
        let acc = match s.wallet_acc(&id, who) {
            Some(a) => Some(a),
            None if book.wallets.len() < MAX_PARTICIPANTS => {
                book.wallets.push(who.clone());
                Some(WalletAcc {
                    stake: vec![0; n],
                    at_market: vec![0; n],
                })
            }
            None => None,
        };
        if let Some(mut acc) = acc {
            for o in 0..n {
                acc.stake[o] += w[o] as u64;
                acc.at_market[o] += w[o] as u64 * m[o] as u64;
            }
            s.set_wallet_acc(&id, who, &acc);
        }
    }
    s.set_book(&id, &book);
    Ok(())
}

/// What `score` did: books scored, and books set aside (50-50 or void).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scored {
    pub books: u32,
    pub void: u32,
}

/// A wallet's edge on a book, in basis points: Σ_o A_o·(y_o − m_o) / Σ_o A_o.
/// Above 0 when its sugar leaned towards what happened, beyond the price.
pub fn wallet_edge(acc: &WalletAcc, y: &[u16]) -> Option<i64> {
    let total: u64 = acc.stake.iter().sum();
    if total == 0 {
        return None;
    }
    let num: i128 = (0..y.len())
        .map(|o| acc.stake[o] as i128 * y[o] as i128 - acc.at_market[o] as i128)
        .sum();
    Some((num / total as i128) as i64)
}

/// Score every unscored book of a market whose resolution is final.
pub fn score(s: &mut impl Store, market_id: &str, r: &Resolution) -> Result<Scored, Error> {
    if !is_final(r.state) {
        return Err(Error::NotResolved);
    }
    let mut done = Scored::default();
    for id in s.book_ids(market_id) {
        let Some(mut book) = s.book(&id) else { continue };
        if book.scored {
            continue;
        }
        book.scored = true;
        let mut t = s.tally();
        // A 50-50 market is counted, not scored: an even split says nothing
        // about which source saw it coming.
        let y = (r.state != FIFTY_FIFTY).then(|| outcome_vector(r, &book.outcomes)).flatten();
        let Some(y) = y else {
            if r.state == FIFTY_FIFTY {
                t.fifty_fifty += 1;
            } else {
                t.void += 1;
            }
            done.void += 1;
            s.set_tally(&t);
            s.set_book(&id, &book);
            continue;
        };
        t.books += 1;
        for (k, src) in book.src.iter().enumerate() {
            if let Some((own, mkt)) = src.briers(&y) {
                let st = &mut t.src[k];
                st.count += 1;
                st.brier_sum += own;
                st.market_sum += mkt;
                st.skill_sum += mkt as i64 - own as i64;
            }
        }
        s.set_tally(&t);
        for who in &book.agents {
            let Some((own, mkt)) = s.agent_acc(&id, who).and_then(|a| a.briers(&y)) else {
                continue;
            };
            let mut at = s.agent_tally(who).unwrap_or_default();
            at.markets += 1;
            at.sum += mkt as i64 - own as i64;
            s.set_agent_tally(who, &at);
        }
        for who in &book.wallets {
            let Some(edge) = s.wallet_acc(&id, who).and_then(|a| wallet_edge(&a, &y)) else {
                continue;
            };
            let mut wt = s.wallet_tally(who).unwrap_or_default();
            wt.markets += 1;
            wt.sum += edge;
            s.set_wallet_tally(who, &wt);
        }
        s.set_book(&id, &book);
        done.books += 1;
    }
    Ok(done)
}

/// What the scorebook lends a forecast when its inputs freeze: each agent's
/// weight in the Agents colony's median, each wallet's multiplier on its
/// sqrt-stake in the Community colony, and the three colonies' weights in the
/// swarm belief.
pub struct Skill<'a> {
    pub agent: &'a dyn Fn(&str) -> u16,
    pub wallet: &'a dyn Fn(&str) -> u16,
    pub colonies: [u16; 3],
}

fn equal_weight(_: &str) -> u16 {
    EQUAL
}

impl Skill<'static> {
    /// No record anywhere: every weight 1000, today's results exactly.
    pub fn equal() -> Skill<'static> {
        Skill {
            agent: &equal_weight,
            wallet: &equal_weight,
            colonies: [EQUAL; 3],
        }
    }
}

/// clamp(1000 + gain·sum / (n + prior), lo, hi); the division truncates
/// towards zero.
fn skill_weight(sum: i64, n: u32, gain: i64, prior: i64, lo: i64, hi: i64) -> u16 {
    (EQUAL as i64 + gain * sum / (n as i64 + prior)).clamp(lo, hi) as u16
}

/// Momentum, Community and Agents' weights in the swarm belief: equal until
/// `MIN_SCORED` books are scored, then clamp(1000 + 5·Σskill / (count + 20),
/// 250, 4000) each.
pub fn colony_weights(t: &Tally) -> [u16; 3] {
    if t.books < MIN_SCORED {
        return [EQUAL; 3];
    }
    [MOMENTUM, COMMUNITY, AGENTS].map(|k| {
        let st = &t.src[k];
        skill_weight(st.skill_sum, st.count, 5, 20, 250, 4000)
    })
}

/// An agent's weight in the Agents colony's median:
/// clamp(1000 + 5·Σskill / (markets + 20), 250, 4000); 1000 with no record.
pub fn agent_weight(t: Option<&SkillTally>) -> u16 {
    t.map_or(EQUAL, |t| skill_weight(t.sum, t.markets, 5, 20, 250, 4000))
}

/// A wallet's multiplier on its sqrt-stake in the Community colony, per
/// mille: clamp(1000 + Σedge / (2·(markets + 20)), 500, 2000); 1000 with no
/// record.
pub fn wallet_mult(t: Option<&SkillTally>) -> u16 {
    t.map_or(EQUAL, |t| {
        (EQUAL as i64 + t.sum / (2 * (t.markets as i64 + 20))).clamp(500, 2000) as u16
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::resolve::{PROPOSED, RESOLVED};
    use std::collections::BTreeMap;

    /// The scorebook in memory, for tests.
    #[derive(Default)]
    pub struct MemStore {
        books: BTreeMap<[u8; 32], Book>,
        ids: BTreeMap<String, Vec<[u8; 32]>>,
        agent_accs: BTreeMap<([u8; 32], String), PairAcc>,
        wallet_accs: BTreeMap<([u8; 32], String), WalletAcc>,
        tally: Option<Tally>,
        agents: BTreeMap<String, SkillTally>,
        wallets: BTreeMap<String, SkillTally>,
    }

    impl Store for MemStore {
        fn book(&self, id: &[u8; 32]) -> Option<Book> {
            self.books.get(id).cloned()
        }
        fn set_book(&mut self, id: &[u8; 32], b: &Book) {
            self.books.insert(*id, b.clone());
        }
        fn book_ids(&self, m: &str) -> Vec<[u8; 32]> {
            self.ids.get(m).cloned().unwrap_or_default()
        }
        fn set_book_ids(&mut self, m: &str, ids: &[[u8; 32]]) {
            self.ids.insert(m.into(), ids.to_vec());
        }
        fn agent_acc(&self, b: &[u8; 32], w: &str) -> Option<PairAcc> {
            self.agent_accs.get(&(*b, w.into())).cloned()
        }
        fn set_agent_acc(&mut self, b: &[u8; 32], w: &str, a: &PairAcc) {
            self.agent_accs.insert((*b, w.into()), a.clone());
        }
        fn wallet_acc(&self, b: &[u8; 32], w: &str) -> Option<WalletAcc> {
            self.wallet_accs.get(&(*b, w.into())).cloned()
        }
        fn set_wallet_acc(&mut self, b: &[u8; 32], w: &str, a: &WalletAcc) {
            self.wallet_accs.insert((*b, w.into()), a.clone());
        }
        fn tally(&self) -> Tally {
            self.tally.clone().unwrap_or_default()
        }
        fn set_tally(&mut self, t: &Tally) {
            self.tally = Some(t.clone());
        }
        fn agent_tally(&self, w: &str) -> Option<SkillTally> {
            self.agents.get(w).cloned()
        }
        fn set_agent_tally(&mut self, w: &str, t: &SkillTally) {
            self.agents.insert(w.into(), t.clone());
        }
        fn wallet_tally(&self, w: &str) -> Option<SkillTally> {
            self.wallets.get(w).cloned()
        }
        fn set_wallet_tally(&mut self, w: &str, t: &SkillTally) {
            self.wallets.insert(w.into(), t.clone());
        }
    }

    fn labels() -> Vec<String> {
        vec!["Yes".into(), "No".into()]
    }

    fn resolved(winner: &str) -> Resolution {
        Resolution {
            state: RESOLVED,
            winner: winner.into(),
            end_ms: 0,
            raw_hashes: vec![],
        }
    }

    /// Record one forecast of "m" with market odds `odds`, the three colonies
    /// at `shares` (Community abstaining), and the given agents and wallets.
    fn rec(
        s: &mut MemStore,
        odds: [u16; 2],
        shares: [u16; 2],
        agents: &[(&str, [u16; 2])],
        wallets: &[(&str, [u32; 2])],
    ) {
        let agents: Vec<(AccountId, Vec<u16>)> =
            agents.iter().map(|(a, p)| (a.to_string(), p.to_vec())).collect();
        let wallets: Vec<(AccountId, Vec<u32>)> =
            wallets.iter().map(|(a, w)| (a.to_string(), w.to_vec())).collect();
        let sh = vec![shares.to_vec(); 3];
        record(
            s,
            &Forecast {
                market_id: "m",
                outcomes: &labels(),
                odds: &odds,
                shares: &sh,
                counted: [true, false, true],
                swarm: &shares,
                agents: &agents,
                wallets: &wallets,
            },
        )
        .unwrap();
    }

    #[test]
    fn brier_from_sums_matches_the_direct_mean() {
        let mut a = Acc::new(2);
        let ps = [[7000u16, 3000], [6000, 4000], [9000, 1000]];
        for p in ps {
            a.add(&p);
        }
        let y = [10_000u16, 0];
        let direct: u64 = ps
            .iter()
            .map(|p| {
                p.iter()
                    .zip(y)
                    .map(|(&p, y)| (p as i64 - y as i64).pow(2) as u64)
                    .sum::<u64>()
            })
            .sum::<u64>()
            / (3 * BPS);
        assert_eq!(a.brier(&y), Some(direct));
        // 0.7 → 2·0.09, 0.6 → 2·0.16, 0.9 → 2·0.01: mean 0.1733.
        assert_eq!(direct, 1733);
        assert_eq!(Acc::new(2).brier(&y), None);
    }

    #[test]
    fn normalize_sums_to_10000() {
        assert_eq!(normalize(&[6000, 3000]), vec![6667, 3333]);
        assert_eq!(normalize(&[3333, 3333, 3333]), vec![3334, 3333, 3333]);
        assert_eq!(normalize(&[0, 5000]), vec![0, 10_000]);
    }

    #[test]
    fn copying_the_market_scores_zero_and_beating_it_scores_above() {
        let mut s = MemStore::default();
        rec(&mut s, [6000, 4000], [8000, 2000], &[("copy", [6000, 4000]), ("sharp", [9000, 1000])], &[]);
        rec(&mut s, [7000, 3000], [8000, 2000], &[("copy", [7000, 3000])], &[]);
        assert_eq!(score(&mut s, "m", &resolved("Yes")), Ok(Scored { books: 1, void: 0 }));
        let t = s.tally();
        assert_eq!(t.books, 1);
        // Community never counted, so it isn't scored.
        assert_eq!(t.src[COMMUNITY], SrcTally::default());
        // Market: mean of 2·0.16 and 2·0.09 = 0.25.
        assert_eq!(t.src[MARKET].brier_sum, 2500);
        assert_eq!(t.src[MARKET].skill_sum, 0);
        // The colonies said 0.8 both times: 0.08, so skill 0.17.
        assert_eq!((t.src[MOMENTUM].brier_sum, t.src[MOMENTUM].skill_sum), (800, 1700));
        assert_eq!(s.agent_tally("copy"), Some(SkillTally { markets: 1, sum: 0 }));
        // "sharp" posted once, against the market's 0.6 that round: 0.32 − 0.02.
        assert_eq!(s.agent_tally("sharp"), Some(SkillTally { markets: 1, sum: 3000 }));
        // Scored books take no more forecasts and aren't scored twice.
        rec(&mut s, [1000, 9000], [1000, 9000], &[], &[]);
        assert_eq!(score(&mut s, "m", &resolved("Yes")), Ok(Scored::default()));
        assert_eq!(s.tally().books, 1);
    }

    #[test]
    fn wallet_edge_is_lean_beyond_the_price() {
        let mut s = MemStore::default();
        rec(&mut s, [6000, 4000], [5000, 5000], &[], &[("bull", [1000, 0]), ("bear", [0, 1000]), ("none", [0, 0])]);
        score(&mut s, "m", &resolved("Yes")).unwrap();
        // Sugar on Yes at 0.6, Yes happened: +0.4. On No at 0.4: −0.4.
        assert_eq!(s.wallet_tally("bull"), Some(SkillTally { markets: 1, sum: 4000 }));
        assert_eq!(s.wallet_tally("bear"), Some(SkillTally { markets: 1, sum: -4000 }));
        assert_eq!(s.wallet_tally("none"), None);
    }

    #[test]
    fn needs_a_final_resolution_and_voids_unknown_winners() {
        let mut s = MemStore::default();
        rec(&mut s, [6000, 4000], [5000, 5000], &[], &[]);
        let open = Resolution { state: PROPOSED, ..resolved("") };
        assert_eq!(score(&mut s, "m", &open), Err(Error::NotResolved));
        assert_eq!(score(&mut s, "m", &resolved("Maybe")), Ok(Scored { books: 0, void: 1 }));
        assert_eq!((s.tally().books, s.tally().void), (0, 1));
    }

    #[test]
    fn fifty_fifty_is_counted_not_scored() {
        let mut s = MemStore::default();
        rec(&mut s, [6000, 4000], [5000, 5000], &[("a", [9000, 1000])], &[]);
        let split = Resolution { state: FIFTY_FIFTY, ..resolved("") };
        assert_eq!(score(&mut s, "m", &split), Ok(Scored { books: 0, void: 1 }));
        let t = s.tally();
        assert_eq!((t.books, t.fifty_fifty, t.void, t.src[MARKET].count), (0, 1, 0, 0));
        assert_eq!(s.agent_tally("a"), None);
    }

    #[test]
    fn new_labels_start_a_new_book() {
        let mut s = MemStore::default();
        rec(&mut s, [6000, 4000], [5000, 5000], &[], &[]);
        let three: Vec<String> = vec!["Yes".into(), "No".into(), "Other".into()];
        let sh = vec![vec![4000, 3000, 3000]; 3];
        record(
            &mut s,
            &Forecast {
                market_id: "m",
                outcomes: &three,
                odds: &[5000, 3000, 2000],
                shares: &sh,
                counted: [true; 3],
                swarm: &[4000, 3000, 3000],
                agents: &[],
                wallets: &[],
            },
        )
        .unwrap();
        assert_eq!(s.book_ids("m").len(), 2);
        assert_eq!(score(&mut s, "m", &resolved("Yes")).unwrap().books, 2);
    }

    #[test]
    fn weights_are_equal_until_enough_books_then_follow_skill() {
        let mut t = Tally::default();
        t.src[MOMENTUM] = SrcTally { count: 30, skill_sum: -30 * 300, ..Default::default() };
        t.src[COMMUNITY] = SrcTally { count: 5, skill_sum: 0, ..Default::default() };
        t.src[AGENTS] = SrcTally { count: 30, skill_sum: 30 * 200, ..Default::default() };
        t.books = MIN_SCORED - 1;
        assert_eq!(colony_weights(&t), [EQUAL; 3]);
        t.books = 30;
        // 1000 + 5·(−9000)/50 = 100 → floor 250; 1000; 1000 + 5·6000/50 = 1600.
        assert_eq!(colony_weights(&t), [250, 1000, 1600]);
    }

    #[test]
    fn one_lucky_market_moves_an_agent_a_little() {
        assert_eq!(agent_weight(None), EQUAL);
        // +0.14 once: 1000 + 5·1400/21.
        assert_eq!(agent_weight(Some(&SkillTally { markets: 1, sum: 1400 })), 1333);
        assert_eq!(agent_weight(Some(&SkillTally { markets: 40, sum: -40 * 1000 })), 250);
        assert_eq!(wallet_mult(None), EQUAL);
        // One stake at 0.3 that came true: +0.7 → 1000 + 7000/42.
        assert_eq!(wallet_mult(Some(&SkillTally { markets: 1, sum: 7000 })), 1166);
        assert_eq!(wallet_mult(Some(&SkillTally { markets: 100, sum: 100 * 5000 })), 2000);
    }
}
