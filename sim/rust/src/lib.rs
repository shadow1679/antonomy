//! Antonomy simulation, Rust port of sim/python/antosim.py (spec v1).
//!
//! Must match the Python reference and the JS port bit for bit. Integer
//! arithmetic only: positions are Q8 fixed point, headings are 16 directions
//! from a lookup table, the PRNG is xoshiro128**. `Colony` advances one tick at
//! a time so a contract can spread a run over several calls; `run` loops it.
//!
//! Inputs besides the seed: per-option richness from a stake snapshot
//! (`stake_richness`) or an odds snapshot (`odds_richness`), and the two
//! snapshot hashes, which go into the result hash (`burn_run`, `forecast_run`).
//!
//! Forecast colonies: `forecast_market` runs the four forecasters on one
//! market, each on its own map (`colony_seed`), and `market_result` turns their
//! scores into trail shares, the swarm belief and one market hash. A contract
//! that steps the four `Colony`s itself calls `market_result` at the end.
//!
//! Not yet implemented (same gaps as the reference): map templates, per-colony
//! personality parameters.

mod sha256;
#[rustfmt::skip]
mod tables;

pub use sha256::{sha256, to_hex};
use tables::{COS64, SIN64};

// --- Parameters (immutable contract constants in production) ---------------
pub const W: i32 = 72;
pub const H: i32 = 48;
pub const NEST_X: i32 = 36;
pub const NEST_Y: i32 = 24;
pub const N_ANTS: usize = 150;
pub const TICKS: u32 = 800;
pub const CAP: u32 = 20 * 256; // pheromone cap per cell, Q8
const DECAY_Q16: u64 = 65536 - 524; // per-tick retention, ~0.8% evaporation
const SENSE_DIST: i32 = 3;
const WANDER: u32 = 64; // out of 256: chance per step of a random turn
const DEPOSIT_BASE: i32 = 512;
const FOOD_RADIUS_SQ: i32 = 4;
const NEST_RADIUS_SQ: i32 = 4;
const SCORE_RADIUS_SQ: i32 = 36;
const RICH_MIN: u32 = 179;
const RICH_SPAN: u32 = 155;
const DIST_MIN: u32 = 9;
const DIST_SPAN: u32 = 13;
const MARGIN: i32 = 4;
pub const VERSION: &[u8] = b"ANTO-SIM-v1";

// --- Snapshot inputs ----------------------------------------------------------
const BPS: u64 = 10_000;
const MOMENTUM_FLOOR: i64 = 200; // 2% floor on the Momentum food weight
const COMMUNITY_BASE: u64 = 10_000; // flat food weight per outcome, milli sqrt-tokens
const ODDS_TAG: &[u8] = b"ANTO-ODDS-v0";

/// How a forecaster reads the odds snapshot. `Community` reads stakes instead.
/// The discriminant is the forecaster slot in `colony_seed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Follower = 0,
    Contrarian = 1,
    Momentum = 2,
    Community = 3,
}

pub const KINDS: [Kind; 4] = [
    Kind::Follower,
    Kind::Contrarian,
    Kind::Momentum,
    Kind::Community,
];

// --- Forecast colonies ---
pub const FORECAST_ANTS: usize = 60; // design doc section 15, scaling option 1
pub const FORECAST_TICKS: u32 = 300;
/// Colony ids match the staking colony ids: 0 = Burn, 1 + m = market m of the round.
pub const BURN_COLONY: u16 = 0;
const COLONY_TAG: &[u8] = b"ANTO-COLONY-v0";
const MARKET_TAG: &[u8] = b"ANTO-MARKET-v0";

const fn heading_table(src: &[i32; 64]) -> [i32; 16] {
    let mut out = [0; 16];
    let mut k = 0;
    while k < 16 {
        out[k] = src[k * 4];
        k += 1;
    }
    out
}
pub const DX: [i32; 16] = heading_table(&COS64);
pub const DY: [i32; 16] = heading_table(&SIN64);

/// Lazy evaporation: `DECAY_T[n]` = retention factor (Q16) after n ticks.
const DECAY_T: [u32; TICKS as usize + 2] = {
    let mut t = [65536u32; TICKS as usize + 2];
    let mut n = 1;
    while n < t.len() {
        t[n] = ((t[n - 1] as u64 * DECAY_Q16) >> 16) as u32;
        n += 1;
    }
    t
};

/// Pheromone in a cell at tick `t`, decayed since it was last touched.
fn decayed(val: u32, last: u16, t: u32) -> u32 {
    ((val as u64 * DECAY_T[(t - last as u32) as usize] as u64) >> 16) as u32
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Outcome count must be 2 to 5.
    BadOutcomeCount(usize),
    /// `richness` must have one entry per outcome.
    BadRichnessLen { expected: usize, got: usize },
    /// Ticks must not exceed `TICKS` (the decay table length).
    TooManyTicks(u32),
    /// `result()` called before the final tick.
    NotFinished,
    /// Odds must be 2 to 5 basis-point values (at most 10000) with a matching
    /// six-hour series, and the kind must be one that reads odds.
    BadOdds,
    /// Stake weights must be 2 to 5 values.
    BadWeights,
    /// `market_result` needs one run per kind, all with the same outcome count.
    BadMarketRuns,
}

/// Snapshot hashes committed in the result hash. All zeros when a colony
/// doesn't read that snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Commit {
    pub stake_hash: [u8; 32],
    pub odds_hash: [u8; 32],
}

/// Food weights -> Q8 richness in the 0.7..1.3 band, the richest source on top.
/// Scaling by the largest weight makes the result independent of the total.
fn scale_richness(weights: &[u64]) -> Option<Vec<u16>> {
    let top = *weights.iter().max()?;
    if top == 0 {
        return None;
    }
    Some(
        weights
            .iter()
            .map(|&w| (RICH_MIN as u64 + RICH_SPAN as u64 * (w * BPS / top) / BPS) as u16)
            .collect(),
    )
}

fn check_odds(odds: &[u16], odds_6h: &[u16]) -> Result<(), Error> {
    let ok = (2..=5).contains(&odds.len())
        && odds_6h.len() == odds.len()
        && odds.iter().chain(odds_6h).all(|&o| o as u64 <= BPS);
    if ok {
        Ok(())
    } else {
        Err(Error::BadOdds)
    }
}

/// Per-option Q8 richness for Follower, Contrarian or Momentum. `odds` and
/// `odds_6h` are basis points per outcome now and six hours ago.
pub fn odds_richness(kind: Kind, odds: &[u16], odds_6h: &[u16]) -> Result<Vec<u16>, Error> {
    check_odds(odds, odds_6h)?;
    let w: Vec<u64> = match kind {
        Kind::Follower => odds.iter().map(|&o| o as u64).collect(),
        Kind::Contrarian => odds.iter().map(|&o| (BPS - o as u64) / 4).collect(),
        Kind::Momentum => odds
            .iter()
            .zip(odds_6h)
            .map(|(&o, &p)| (o as i64 + 2 * (o as i64 - p as i64)).max(MOMENTUM_FLOOR) as u64)
            .collect(),
        Kind::Community => return Err(Error::BadOdds),
    };
    scale_richness(&w).ok_or(Error::BadOdds)
}

/// Per-option Q8 richness from stake weights (Burn and Community colonies):
/// per option, the sum over wallets of sqrt(tokens staked) in milli-units.
/// Every option starts from the same flat base, so with no stakes the food is even.
pub fn stake_richness(weights: &[u32]) -> Result<Vec<u16>, Error> {
    if !(2..=5).contains(&weights.len()) {
        return Err(Error::BadWeights);
    }
    let w: Vec<u64> = weights.iter().map(|&x| COMMUNITY_BASE + x as u64).collect();
    scale_richness(&w).ok_or(Error::BadWeights)
}

/// Hash of the odds snapshot: the second input commitment in the result hash.
pub fn odds_snapshot_hash(odds: &[u16], odds_6h: &[u16]) -> Result<[u8; 32], Error> {
    check_odds(odds, odds_6h)?;
    let mut buf = ODDS_TAG.to_vec();
    buf.push(odds.len() as u8);
    for o in odds.iter().chain(odds_6h) {
        buf.extend_from_slice(&o.to_be_bytes());
    }
    Ok(sha256(&buf))
}

/// xoshiro128**, seeded from sha256(b"ANTO-RNG-v0" + seed).
#[derive(Debug, Clone)]
pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    pub fn new(seed: &[u8; 32]) -> Rng {
        let mut buf = b"ANTO-RNG-v0".to_vec();
        buf.extend_from_slice(seed);
        let h = sha256(&buf);
        let mut s = [0u32; 4];
        for (i, w) in s.iter_mut().enumerate() {
            *w = u32::from_be_bytes([h[i * 4], h[i * 4 + 1], h[i * 4 + 2], h[i * 4 + 3]]);
        }
        if s == [0; 4] {
            s[0] = 1;
        }
        Rng { s }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> u32 {
        let [mut s0, mut s1, mut s2, mut s3] = self.s;
        let result = s1.wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s1 << 9;
        s2 ^= s0;
        s3 ^= s1;
        s1 ^= s2;
        s0 ^= s3;
        s2 ^= t;
        s3 = s3.rotate_left(11);
        self.s = [s0, s1, s2, s3];
        result
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimResult {
    pub winner_source: usize,
    pub winner_option: usize,
    pub scores: Vec<u32>,
    /// `perm[option]` = food source holding that option.
    pub perm: Vec<u8>,
    /// (x, y, richness Q8) per source.
    pub sources: Vec<(u8, u8, u16)>,
    pub hash: [u8; 32],
}

impl SimResult {
    pub fn hash_hex(&self) -> String {
        to_hex(&self.hash)
    }
}

/// One colony, advanced one tick at a time. Fields are public for reading
/// (the replay and a contract's state dump); callers must not mutate them.
#[derive(Debug, Clone)]
pub struct Colony {
    pub rng: Rng,
    pub seed: [u8; 32],
    pub n: usize,
    pub ants: usize,
    pub ticks: u32,
    pub t: u32,
    pub commit: Commit,
    pub sx: Vec<i32>,
    pub sy: Vec<i32>,
    pub rich: Vec<u16>,
    pub perm: Vec<u8>,
    pub val: Vec<u32>,
    pub last: Vec<u16>,
    pub ax: Vec<i32>,
    pub ay: Vec<i32>,
    pub ah: Vec<i32>,
    pub returning: Vec<bool>,
    pub strength: Vec<i32>,
}

impl Colony {
    /// A colony that reads no snapshots: no commitments in its hash.
    pub fn new(
        seed: &[u8; 32],
        n: usize,
        richness: Option<&[u16]>,
        ants: usize,
        ticks: u32,
    ) -> Result<Colony, Error> {
        Colony::with_commit(seed, n, richness, Commit::default(), ants, ticks)
    }

    /// `richness`, if given, has one Q8 value per option and replaces the
    /// seed-derived richness (forecast and Burn colonies). The seed draws are
    /// still made so the stream stays aligned. `commit` is hashed into the result.
    pub fn with_commit(
        seed: &[u8; 32],
        n: usize,
        richness: Option<&[u16]>,
        commit: Commit,
        ants: usize,
        ticks: u32,
    ) -> Result<Colony, Error> {
        if !(2..=5).contains(&n) {
            return Err(Error::BadOutcomeCount(n));
        }
        if let Some(r) = richness {
            if r.len() != n {
                return Err(Error::BadRichnessLen {
                    expected: n,
                    got: r.len(),
                });
            }
        }
        if ticks > TICKS {
            return Err(Error::TooManyTicks(ticks));
        }
        let mut rng = Rng::new(seed);

        let mut sx = Vec::with_capacity(n);
        let mut sy = Vec::with_capacity(n);
        for i in 0..n {
            let idx = (((i * 64) / n) as i32 + (rng.next() % 8) as i32 - 4) & 63;
            let dist = (DIST_MIN + rng.next() % DIST_SPAN) as i32;
            let fx = NEST_X + ((COS64[idx as usize] * dist) >> 8);
            let fy = NEST_Y + ((SIN64[idx as usize] * dist) >> 8);
            sx.push(fx.clamp(MARGIN, W - 1 - MARGIN));
            sy.push(fy.clamp(MARGIN, H - 1 - MARGIN));
        }
        let mut rich: Vec<u16> = (0..n)
            .map(|_| (RICH_MIN + rng.next() % RICH_SPAN) as u16)
            .collect();

        let mut perm: Vec<u8> = (0..n as u8).collect();
        for i in (1..n).rev() {
            let j = (rng.next() % (i as u32 + 1)) as usize;
            perm.swap(i, j);
        }

        // Supplied richness belongs to options, so it follows the shuffle.
        if let Some(r) = richness {
            for o in 0..n {
                rich[perm[o] as usize] = r[o];
            }
        }

        let ah = (0..ants).map(|_| (rng.next() & 15) as i32).collect();
        Ok(Colony {
            rng,
            seed: *seed,
            n,
            ants,
            ticks,
            t: 0,
            commit,
            sx,
            sy,
            rich,
            perm,
            val: vec![0; (W * H) as usize],
            last: vec![0; (W * H) as usize],
            ax: vec![NEST_X * 256 + 128; ants],
            ay: vec![NEST_Y * 256 + 128; ants],
            ah,
            returning: vec![false; ants],
            strength: vec![0; ants],
        })
    }

    /// Advance one tick. Returns false once the final tick has already run.
    pub fn step(&mut self) -> bool {
        if self.t >= self.ticks {
            return false;
        }
        self.t += 1;
        let t = self.t;
        let nest_tx = NEST_X * 256 + 128;
        let nest_ty = NEST_Y * 256 + 128;

        for a in 0..self.ants {
            let r = self.rng.next();
            let wander = (r & 255) < WANDER;
            let turn = (((r >> 8) & 255) % 3) as i32 - 1;
            let mut h = self.ah[a];
            let mut x = self.ax[a];
            let mut y = self.ay[a];

            if !self.returning[a] {
                // Sample straight ahead, then left, then right; strictly
                // greater wins, so ties keep the earlier (straighter) choice.
                let mut best: i64 = -1;
                let mut bh = h;
                for d in [0, -1, 1] {
                    let hh = (h + d) & 15;
                    let cx = (x + DX[hh as usize] * SENSE_DIST) >> 8;
                    let cy = (y + DY[hh as usize] * SENSE_DIST) >> 8;
                    let v = if (0..W).contains(&cx) && (0..H).contains(&cy) {
                        let i = (cy * W + cx) as usize;
                        decayed(self.val[i], self.last[i], t) as i64
                    } else {
                        0
                    };
                    if v > best {
                        best = v;
                        bh = hh;
                    }
                }
                h = bh;
            } else {
                // Head home: the heading with the largest dot product, lowest
                // index on ties.
                let dx = nest_tx - x;
                let dy = nest_ty - y;
                let mut best = i32::MIN;
                let mut bk = 0;
                for k in 0..16 {
                    let dot = DX[k] * dx + DY[k] * dy;
                    if k == 0 || dot > best {
                        best = dot;
                        bk = k;
                    }
                }
                h = bk as i32;
            }

            if wander {
                h = (h + turn) & 15;
            }

            let nx = x + DX[h as usize];
            let ny = y + DY[h as usize];
            let cx = nx >> 8;
            let cy = ny >> 8;
            if !(0..W).contains(&cx) || !(0..H).contains(&cy) {
                h = (h + 8) & 15;
            } else {
                x = nx;
                y = ny;
                if !self.returning[a] {
                    for s in 0..self.n {
                        let ddx = cx - self.sx[s];
                        let ddy = cy - self.sy[s];
                        if ddx * ddx + ddy * ddy <= FOOD_RADIUS_SQ {
                            self.returning[a] = true;
                            self.strength[a] = (DEPOSIT_BASE * self.rich[s] as i32) >> 8;
                            h = (h + 8) & 15;
                            break;
                        }
                    }
                } else {
                    let i = (cy * W + cx) as usize;
                    let v = decayed(self.val[i], self.last[i], t) as i64 + self.strength[a] as i64;
                    self.val[i] = v.min(CAP as i64) as u32;
                    self.last[i] = t as u16;
                    self.strength[a] -= self.strength[a] >> 5;
                    let ddx = cx - NEST_X;
                    let ddy = cy - NEST_Y;
                    if ddx * ddx + ddy * ddy <= NEST_RADIUS_SQ {
                        self.returning[a] = false;
                        self.strength[a] = 0;
                        h = (h + 8) & 15;
                    }
                }
            }

            self.ah[a] = h;
            self.ax[a] = x;
            self.ay[a] = y;
        }
        true
    }

    /// Pheromone in cell `i` at the current tick (lazy evaporation).
    pub fn cell(&self, i: usize) -> u32 {
        decayed(self.val[i], self.last[i], self.t)
    }

    /// Pheromone within the score radius of each source, at the current tick.
    pub fn scores(&self) -> Vec<u32> {
        (0..self.n)
            .map(|s| {
                let (sx, sy) = (self.sx[s], self.sy[s]);
                let mut total = 0u32;
                for yy in sy - 6..=sy + 6 {
                    for xx in sx - 6..=sx + 6 {
                        let ddx = xx - sx;
                        let ddy = yy - sy;
                        if ddx * ddx + ddy * ddy <= SCORE_RADIUS_SQ
                            && (0..W).contains(&xx)
                            && (0..H).contains(&yy)
                        {
                            total += self.cell((yy * W + xx) as usize);
                        }
                    }
                }
                total
            })
            .collect()
    }

    /// Final result and hash. Only valid after the last tick.
    pub fn result(&self) -> Result<SimResult, Error> {
        if self.t != self.ticks {
            return Err(Error::NotFinished);
        }
        let scores = self.scores();
        let mut win_src = 0;
        for s in 1..self.n {
            if scores[s] > scores[win_src] {
                win_src = s;
            }
        }
        let win_opt = self
            .perm
            .iter()
            .position(|&p| p as usize == win_src)
            .unwrap();

        let mut buf = VERSION.to_vec();
        buf.extend_from_slice(&self.seed);
        buf.push(self.n as u8);
        buf.extend_from_slice(&self.commit.stake_hash);
        buf.extend_from_slice(&self.commit.odds_hash);
        let mut sources = Vec::with_capacity(self.n);
        for s in 0..self.n {
            let (x, y) = (self.sx[s] as u8, self.sy[s] as u8);
            sources.push((x, y, self.rich[s]));
            buf.extend_from_slice(&[x, y]);
            buf.extend_from_slice(&self.rich[s].to_be_bytes());
        }
        for v in &scores {
            buf.extend_from_slice(&v.to_be_bytes());
        }
        buf.push(win_src as u8);
        buf.extend_from_slice(&self.perm);

        Ok(SimResult {
            winner_source: win_src,
            winner_option: win_opt,
            scores,
            perm: self.perm.clone(),
            sources,
            hash: sha256(&buf),
        })
    }
}

/// Run one colony start to finish.
pub fn run(
    seed: &[u8; 32],
    n: usize,
    richness: Option<&[u16]>,
    ants: usize,
    ticks: u32,
) -> Result<SimResult, Error> {
    let mut c = Colony::new(seed, n, richness, ants, ticks)?;
    while c.step() {}
    c.result()
}

/// Burn colony: five menu options, richness from the Burn colony's stakes.
pub fn burn_run(
    seed: &[u8; 32],
    weights: &[u32],
    stake_hash: [u8; 32],
    ants: usize,
    ticks: u32,
) -> Result<SimResult, Error> {
    let rich = stake_richness(weights)?;
    let commit = Commit {
        stake_hash,
        odds_hash: [0; 32],
    };
    let mut c = Colony::with_commit(seed, 5, Some(&rich), commit, ants, ticks)?;
    while c.step() {}
    c.result()
}

/// One forecaster on one market. `Community` reads `weights` (that market's
/// stakes); the others read the odds snapshot.
#[allow(clippy::too_many_arguments)]
pub fn forecast_run(
    seed: &[u8; 32],
    kind: Kind,
    odds: &[u16],
    odds_6h: &[u16],
    weights: &[u32],
    stake_hash: [u8; 32],
    ants: usize,
    ticks: u32,
) -> Result<SimResult, Error> {
    let odds_hash = odds_snapshot_hash(odds, odds_6h)?;
    let rich = if kind == Kind::Community {
        if weights.len() != odds.len() {
            return Err(Error::BadWeights);
        }
        stake_richness(weights)?
    } else {
        odds_richness(kind, odds, odds_6h)?
    };
    let commit = Commit {
        stake_hash,
        odds_hash,
    };
    let mut c = Colony::with_commit(seed, odds.len(), Some(&rich), commit, ants, ticks)?;
    while c.step() {}
    c.result()
}

/// Colony id (and staking colony id) of market `m` in the round.
pub const fn market_colony(m: u16) -> u16 {
    1 + m
}

/// Seed for one colony's map: the round seed, the colony id and the
/// forecaster slot (`Kind as u8`; 0 for the Burn colony).
pub fn colony_seed(round_seed: &[u8; 32], colony: u16, slot: u8) -> [u8; 32] {
    let mut buf = COLONY_TAG.to_vec();
    buf.extend_from_slice(round_seed);
    buf.extend_from_slice(&colony.to_be_bytes());
    buf.push(slot);
    sha256(&buf)
}

/// Per-option trail share in basis points, summing to exactly 10000. Each
/// share is floored; the remainder goes to the winning option. With no trail
/// at all every option gets an even share (remainder to the winner).
pub fn trail_shares(r: &SimResult) -> Vec<u16> {
    let scores: Vec<u64> = r
        .perm
        .iter()
        .map(|&s| r.scores[s as usize] as u64)
        .collect();
    let total: u64 = scores.iter().sum();
    let n = scores.len() as u64;
    let mut shares: Vec<u64> = if total == 0 {
        vec![BPS / n; scores.len()]
    } else {
        scores.iter().map(|&x| x * BPS / total).collect()
    };
    shares[r.winner_option] += BPS - shares.iter().sum::<u64>();
    shares.into_iter().map(|x| x as u16).collect()
}

/// The four forecasters of one market combined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketResult {
    pub colony: u16,
    /// One run per kind, in `KINDS` order.
    pub colonies: Vec<SimResult>,
    /// `trail_shares` of each run, in `KINDS` order.
    pub shares: Vec<Vec<u16>>,
    /// Swarm belief per option, basis points summing to 10000.
    pub swarm: Vec<u16>,
    pub hash: [u8; 32],
}

impl MarketResult {
    pub fn hash_hex(&self) -> String {
        to_hex(&self.hash)
    }
}

/// Combine the four forecaster runs (in `KINDS` order) of one market. Swarm
/// belief per option is the floored mean of the four trail shares; the
/// remainder goes to the option with the largest sum (lowest index on ties).
/// Market hash = sha256(tag, colony u16, n u8, four colony hashes, swarm u16 each).
pub fn market_result(colony: u16, runs: Vec<SimResult>) -> Result<MarketResult, Error> {
    if runs.len() != KINDS.len() {
        return Err(Error::BadMarketRuns);
    }
    let n = runs[0].perm.len();
    if runs.iter().any(|r| r.perm.len() != n) {
        return Err(Error::BadMarketRuns);
    }
    let shares: Vec<Vec<u16>> = runs.iter().map(trail_shares).collect();
    let sums: Vec<u64> = (0..n)
        .map(|o| shares.iter().map(|s| s[o] as u64).sum())
        .collect();
    let mut swarm: Vec<u64> = sums.iter().map(|&x| x / KINDS.len() as u64).collect();
    let mut top = 0;
    for o in 1..n {
        if sums[o] > sums[top] {
            top = o;
        }
    }
    swarm[top] += BPS - swarm.iter().sum::<u64>();
    let swarm: Vec<u16> = swarm.into_iter().map(|x| x as u16).collect();

    let mut buf = MARKET_TAG.to_vec();
    buf.extend_from_slice(&colony.to_be_bytes());
    buf.push(n as u8);
    for r in &runs {
        buf.extend_from_slice(&r.hash);
    }
    for x in &swarm {
        buf.extend_from_slice(&x.to_be_bytes());
    }
    Ok(MarketResult {
        colony,
        colonies: runs,
        shares,
        swarm,
        hash: sha256(&buf),
    })
}

/// The four forecasters on one market, each on its own map. `colony` is the
/// market's colony id (`market_colony(m)`); `weights` are that colony's stake
/// weights, one per outcome (zeros when nobody staked).
#[allow(clippy::too_many_arguments)]
pub fn forecast_market(
    round_seed: &[u8; 32],
    colony: u16,
    odds: &[u16],
    odds_6h: &[u16],
    weights: &[u32],
    stake_hash: [u8; 32],
    ants: usize,
    ticks: u32,
) -> Result<MarketResult, Error> {
    let runs = KINDS
        .iter()
        .map(|&k| {
            let seed = colony_seed(round_seed, colony, k as u8);
            forecast_run(&seed, k, odds, odds_6h, weights, stake_hash, ants, ticks)
        })
        .collect::<Result<Vec<_>, _>>()?;
    market_result(colony, runs)
}

pub fn seed_from_int(i: u64) -> [u8; 32] {
    sha256(format!("seed-{i}").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_python_reference_for_seed_0() {
        // Value printed by `python3 -I sim/python/antosim.py 0`.
        let r = run(&seed_from_int(0), 5, None, N_ANTS, TICKS).unwrap();
        assert_eq!(
            r.hash_hex(),
            "30a823b730efe55fadd1ac7e726544e01ea40ae26332b281f87384ed892d8248"
        );
        assert_eq!(r.winner_option, 2);
    }

    #[test]
    fn stepping_in_chunks_equals_one_run() {
        let seed = seed_from_int(7);
        let whole = run(&seed, 4, None, N_ANTS, TICKS).unwrap();
        let mut c = Colony::new(&seed, 4, None, N_ANTS, TICKS).unwrap();
        assert_eq!(c.result(), Err(Error::NotFinished));
        let mut calls = 0;
        while c.t < c.ticks {
            for _ in 0..25 {
                c.step();
            }
            calls += 1;
        }
        assert_eq!(calls, 32);
        assert!(!c.step());
        assert_eq!(c.result().unwrap(), whole);
    }

    #[test]
    fn rejects_bad_arguments() {
        let seed = seed_from_int(0);
        assert_eq!(
            Colony::new(&seed, 1, None, 10, 10).unwrap_err(),
            Error::BadOutcomeCount(1)
        );
        assert_eq!(
            Colony::new(&seed, 6, None, 10, 10).unwrap_err(),
            Error::BadOutcomeCount(6)
        );
        assert_eq!(
            Colony::new(&seed, 3, Some(&[1, 2]), 10, 10).unwrap_err(),
            Error::BadRichnessLen {
                expected: 3,
                got: 2
            }
        );
        assert_eq!(
            Colony::new(&seed, 3, None, 10, TICKS + 1).unwrap_err(),
            Error::TooManyTicks(TICKS + 1)
        );
    }

    #[test]
    fn odds_richness_matches_reference() {
        // Values printed by antosim.odds_richness in the Python reference.
        let (o, p) = ([9000, 1000], [8000, 2000]);
        assert_eq!(
            odds_richness(Kind::Follower, &o, &p).unwrap(),
            vec![334, 196]
        );
        assert_eq!(
            odds_richness(Kind::Contrarian, &o, &p).unwrap(),
            vec![196, 334]
        );
        assert_eq!(
            odds_richness(Kind::Momentum, &o, &p).unwrap(),
            vec![334, 181]
        );
        assert_eq!(stake_richness(&[0, 0, 0]).unwrap(), vec![334, 334, 334]);
        assert_eq!(stake_richness(&[20000, 0]).unwrap(), vec![334, 230]);
    }

    #[test]
    fn snapshot_inputs_are_validated() {
        let ok = [5000, 5000];
        assert_eq!(
            odds_richness(Kind::Follower, &[10001, 0], &ok),
            Err(Error::BadOdds)
        );
        assert_eq!(
            odds_richness(Kind::Follower, &ok, &[5000]),
            Err(Error::BadOdds)
        );
        assert_eq!(
            odds_richness(Kind::Follower, &[0, 0], &ok),
            Err(Error::BadOdds)
        );
        assert_eq!(
            odds_richness(Kind::Community, &ok, &ok),
            Err(Error::BadOdds)
        );
        assert_eq!(odds_snapshot_hash(&[1; 6], &[1; 6]), Err(Error::BadOdds));
        assert_eq!(stake_richness(&[1]), Err(Error::BadWeights));
    }

    #[test]
    fn supplied_richness_follows_the_option_not_the_source() {
        let seed = seed_from_int(3);
        let r = [330u16, 200, 250];
        let c = Colony::new(&seed, 3, Some(&r), 10, 10).unwrap();
        for o in 0..3 {
            assert_eq!(c.rich[c.perm[o] as usize], r[o]);
        }
    }

    #[test]
    fn result_commits_to_both_snapshots() {
        let seed = seed_from_int(5);
        let (odds, odds_6h) = ([6000, 3000, 1000], [5000, 4000, 1000]);
        let w = [0u32, 0, 9000];
        let go = |k, o: &[u16], h: [u8; 32]| {
            forecast_run(&seed, k, o, &odds_6h, &w, h, 30, 60)
                .unwrap()
                .hash
        };
        let base = go(Kind::Follower, &odds, [0; 32]);
        assert_eq!(base, go(Kind::Follower, &odds, [0; 32]));
        assert_ne!(base, go(Kind::Follower, &odds, [1; 32]));
        // Odds that give the same richness still change the hash.
        assert_ne!(base, go(Kind::Follower, &[6001, 2999, 1000], [0; 32]));
        // A different kind on the same snapshot is a different run.
        assert_ne!(base, go(Kind::Contrarian, &odds, [0; 32]));
    }

    #[test]
    fn forecast_market_matches_reference() {
        // Values printed by antosim.forecast_market in the Python reference.
        let r = forecast_market(
            &seed_from_int(0),
            market_colony(0),
            &[6200, 2800, 1000],
            &[5500, 3300, 1200],
            &[3000, 0, 12000],
            sha256(b"stakes"),
            FORECAST_ANTS,
            FORECAST_TICKS,
        )
        .unwrap();
        assert_eq!(
            r.shares,
            vec![
                vec![3453, 4000, 2547],
                vec![4093, 2094, 3813],
                vec![3632, 3870, 2498],
                vec![2117, 4081, 3802]
            ]
        );
        assert_eq!(r.swarm, vec![3323, 3512, 3165]);
        assert_eq!(
            r.hash_hex(),
            "07a49f22d7f4d8c28208e085c1763ad28d9984b96200be231ba3314b4f97c1e4"
        );
    }

    #[test]
    fn each_forecaster_gets_its_own_map() {
        let s = seed_from_int(9);
        let seeds: Vec<_> = KINDS.iter().map(|&k| colony_seed(&s, 1, k as u8)).collect();
        for i in 0..4 {
            for j in i + 1..4 {
                assert_ne!(seeds[i], seeds[j]);
            }
            assert_ne!(seeds[i], colony_seed(&s, 2, i as u8));
        }
    }

    #[test]
    fn shares_sum_to_10000_and_remainder_goes_to_winner() {
        let mk = |scores: Vec<u32>, perm: Vec<u8>, winner_option| SimResult {
            winner_source: 0,
            winner_option,
            scores,
            perm,
            sources: vec![],
            hash: [0; 32],
        };
        // Option o reads source perm[o].
        assert_eq!(
            trail_shares(&mk(vec![1, 1, 1], vec![2, 0, 1], 1)),
            vec![3333, 3334, 3333]
        );
        assert_eq!(
            trail_shares(&mk(vec![30, 10], vec![1, 0], 1)),
            vec![2500, 7500]
        );
        assert_eq!(
            trail_shares(&mk(vec![0, 0, 0], vec![0, 1, 2], 0)),
            vec![3334, 3333, 3333]
        );
        let runs = vec![mk(vec![1, 2], vec![0, 1], 1); 4];
        let m = market_result(1, runs.clone()).unwrap();
        assert_eq!(m.swarm, vec![3333, 6667]);
        assert_eq!(
            market_result(1, runs[..3].to_vec()),
            Err(Error::BadMarketRuns)
        );
    }

    #[test]
    fn decay_table_matches_reference_endpoints() {
        assert_eq!(DECAY_T[0], 65536);
        assert_eq!(DECAY_T[1], 65012);
        assert_eq!(DECAY_T.len(), 802);
    }
}
