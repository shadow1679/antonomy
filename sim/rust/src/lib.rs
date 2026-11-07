//! Antonomy simulation, Rust port of sim/python/antosim.py (spec v1).
//!
//! Must match the Python reference and the JS port bit for bit. Integer
//! arithmetic only: positions are Q8 fixed point, headings are 16 directions
//! from a lookup table, the PRNG is xoshiro128**. `Colony` advances one tick at
//! a time so a contract can spread a run over several calls; `run` loops it.
//!
//! Inputs besides the seed: per-option richness from a stake snapshot
//! (`stake_richness`), an odds snapshot (`odds_richness`) or the forecaster
//! agents' median odds (`agent_richness`), and the two snapshot hashes, which
//! go into the result hash (`burn_run`, `forecast_run`).
//!
//! Forecast colonies: `forecast_market` runs the five forecasters on one
//! market, each on its own map (`colony_seed`), and `market_result` turns their
//! scores into trail shares, the swarm belief and one market hash. A contract
//! that runs the five colonies over several calls calls `market_result` at the end.
//!
//! Scoring: a source's score is the pheromone within 6 cells of it,
//! summed at a checkpoint every `SCORE_EVERY` ticks and at the final tick
//! (`Colony::totals`), so a steady lead adds up over a long run.
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
/// Burn colony: 12:00 to 24:00 UTC at one tick per second. The longest run.
pub const BURN_TICKS: u32 = 43_200;
pub const CAP: u32 = 20 * 256; // pheromone cap per cell, Q8
const DECAY_Q16: u64 = 65536 - 524; // per-tick retention, ~0.8% evaporation
const SENSE_DIST: i32 = 3;
const WANDER: u32 = 64; // out of 256: chance per step of a random turn
const DEPOSIT_BASE: i32 = 512;
const FOOD_RADIUS_SQ: i32 = 4;
const NEST_RADIUS_SQ: i32 = 4;
const SCORE_RADIUS_SQ: i32 = 36;
const RICH_MIN: u32 = 90; // richness Q8: 0.35 .. 1.3
const RICH_SPAN: u32 = 244;
/// Largest richness `scale_richness` gives. Supplied richness above it is rejected,
/// which also keeps an ant's deposit strength within u16.
pub const RICH_MAX: u16 = (RICH_MIN + RICH_SPAN) as u16;
const DIST_MIN: u32 = 9;
const DIST_SPAN: u32 = 13;
const MARGIN: i32 = 4;
/// Ticks between score checkpoints.
pub const SCORE_EVERY: u32 = 100;
pub const VERSION: &[u8] = b"ANTO-SIM-v1";

// --- Snapshot inputs ----------------------------------------------------------
const BPS: u64 = 10_000;
const MOMENTUM_FLOOR: i64 = 200; // 2% floor on the Momentum food weight
const COMMUNITY_BASE: u64 = 2_500; // flat food weight per outcome, milli sqrt-tokens
const ODDS_TAG: &[u8] = b"ANTO-ODDS-v0";

/// How a forecaster reads the odds snapshot. `Community` reads stakes and
/// `Agents` reads the forecaster agents' median odds instead.
/// The discriminant is the forecaster slot in `colony_seed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Follower = 0,
    Contrarian = 1,
    Momentum = 2,
    Community = 3,
    Agents = 4,
}

pub const KINDS: [Kind; 5] = [
    Kind::Follower,
    Kind::Contrarian,
    Kind::Momentum,
    Kind::Community,
    Kind::Agents,
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

const fn decay_step(r: u32) -> u32 {
    ((r as u64 * DECAY_Q16) >> 16) as u32
}

/// Ticks until the retention factor reaches 0 (852): a cell untouched for this
/// long holds no pheromone, whatever it held.
pub const FADE_TICKS: usize = {
    let (mut r, mut n) = (65536u32, 0);
    while r > 0 {
        r = decay_step(r);
        n += 1;
    }
    n
};

/// Lazy evaporation: `DECAY_T[n]` = retention factor (Q16) after n ticks, for
/// n up to `FADE_TICKS`; it is 0 from there on.
const DECAY_T: [u32; FADE_TICKS + 1] = {
    let mut t = [65536u32; FADE_TICKS + 1];
    let mut n = 1;
    while n < t.len() {
        t[n] = decay_step(t[n - 1]);
        n += 1;
    }
    t
};

/// Pheromone in a cell at tick `t`, decayed since it was last touched.
fn decayed(val: u16, last: u32, t: u32) -> u32 {
    let age = ((t - last) as usize).min(FADE_TICKS);
    ((val as u64 * DECAY_T[age] as u64) >> 16) as u32
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Outcome count must be 2 to 5.
    BadOutcomeCount(usize),
    /// `richness` must have one entry per outcome.
    BadRichnessLen { expected: usize, got: usize },
    /// Ticks must not exceed `BURN_TICKS`.
    TooManyTicks(u32),
    /// Supplied richness must not exceed `RICH_MAX`.
    BadRichness(u16),
    /// `Colony::from_bytes` got bytes that aren't a stored colony.
    BadState,
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

/// Food weights -> Q8 richness in the 0.35..1.3 band, the richest source on top.
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

/// Food weights -> Q8 richness proportional to the weight, the richest source
/// at the band's top (1.3) and a zero weight at 0: the odds-driven colonies
/// (Follower, Contrarian, Momentum, Agents), so their trail shares track their food.
fn odds_scale(weights: &[u64]) -> Option<Vec<u16>> {
    let top = *weights.iter().max()?;
    if top == 0 {
        return None;
    }
    let rich_top = (RICH_MIN + RICH_SPAN) as u64;
    Some(
        weights
            .iter()
            .map(|&w| (rich_top * w / top) as u16)
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
        Kind::Community | Kind::Agents => return Err(Error::BadOdds),
    };
    odds_scale(&w).ok_or(Error::BadOdds)
}

/// Per-option Q8 richness for the Agents colony: the Follower rule on the
/// forecaster agents' per-outcome median odds (basis points). All zeros means
/// no agent posted, and the map is even.
pub fn agent_richness(agent_odds: &[u16]) -> Result<Vec<u16>, Error> {
    if !(2..=5).contains(&agent_odds.len()) || agent_odds.iter().any(|&o| o as u64 > BPS) {
        return Err(Error::BadOdds);
    }
    let w: Vec<u64> = if agent_odds.iter().any(|&o| o > 0) {
        agent_odds.iter().map(|&o| o as u64).collect()
    } else {
        vec![1; agent_odds.len()]
    };
    odds_scale(&w).ok_or(Error::BadOdds)
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

/// Layout tag of `Colony::to_bytes`, and the size of its fixed header.
const STATE_FORMAT: u8 = 2;
const STATE_HEAD: usize = 1 + 16 + 32 + 1 + 2 + 4 + 4 + 64;

/// Big-endian cursor for `Colony::from_bytes`.
struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let end = self.at + N;
        let s = self.b.get(self.at..end).ok_or(Error::BadState)?;
        self.at = end;
        Ok(s.try_into().unwrap())
    }
    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take::<1>()?[0])
    }
    fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_be_bytes(self.take()?))
    }
    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_be_bytes(self.take()?))
    }
    fn arr32(&mut self) -> Result<[u8; 32], Error> {
        self.take()
    }
}

/// Marks a cell outside every food radius in `Colony::food`.
pub const NO_FOOD: u8 = u8::MAX;

/// Food source per cell: the lowest source index whose food radius covers the
/// cell, or `NO_FOOD`. Same answer as testing each source in order, in one lookup.
fn food_grid(sx: &[i32], sy: &[i32]) -> Vec<u8> {
    let mut food = vec![NO_FOOD; (W * H) as usize];
    // Highest index first, so the lowest index is written last and wins.
    for s in (0..sx.len()).rev() {
        for cy in sy[s] - 2..=sy[s] + 2 {
            for cx in sx[s] - 2..=sx[s] + 2 {
                let (ddx, ddy) = (cx - sx[s], cy - sy[s]);
                if ddx * ddx + ddy * ddy <= FOOD_RADIUS_SQ
                    && (0..W).contains(&cx)
                    && (0..H).contains(&cy)
                {
                    food[(cy * W + cx) as usize] = s as u8;
                }
            }
        }
    }
    food
}

/// Heading home: the heading with the largest dot product with (dx, dy),
/// lowest index on ties. The angle of (dx, dy) lies in one octant, so the
/// answer is one of the three headings bounding or bisecting it; the
/// rounding in the tables is far too small to make any other heading win.
/// `home_heading_matches_full_scan` checks every reachable (dx, dy).
fn home_heading(dx: i32, dy: i32) -> i32 {
    if dx == 0 && dy == 0 {
        return 0; // every dot product is 0
    }
    let (ax, ay) = (dx.abs(), dy.abs());
    let o = if dy >= 0 {
        if dx > 0 {
            if ay <= ax {
                0
            } else {
                1
            }
        } else if ax <= ay {
            2
        } else {
            3
        }
    } else if dx < 0 {
        if ay <= ax {
            4
        } else {
            5
        }
    } else if ax <= ay {
        6
    } else {
        7
    };
    // Ascending index order, so a strict comparison keeps the lowest on ties.
    let ks = if o == 7 {
        [0, 14, 15]
    } else {
        [2 * o, 2 * o + 1, 2 * o + 2]
    };
    let dot = |k: usize| DX[k] * dx + DY[k] * dy;
    let mut bk = ks[0];
    let mut best = dot(bk);
    for &k in &ks[1..] {
        let d = dot(k);
        if d > best {
            best = d;
            bk = k;
        }
    }
    bk as i32
}

/// One colony, advanced one tick at a time. Fields are public for reading
/// (the replay and a contract's state dump); callers must not mutate them.
/// Per-ant and per-cell state uses the narrowest type that holds it, since a
/// contract stores and reloads it on every call: positions are Q8 within the
/// grid (below 72 * 256), pheromone is at most `CAP`, deposit strength at most
/// 2 * `RICH_MAX`. `last` (the tick a cell was last touched) needs 32 bits for
/// a day-long run; `to_bytes` stores it as an age capped at `FADE_TICKS`.
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
    /// Derived from the sources (`food_grid`); not part of the stored state.
    pub food: Vec<u8>,
    pub val: Vec<u16>,
    pub last: Vec<u32>,
    pub ax: Vec<u16>,
    pub ay: Vec<u16>,
    pub ah: Vec<u8>,
    pub returning: Vec<bool>,
    pub strength: Vec<u16>,
    /// Score per source so far: `scores()` summed at every checkpoint.
    pub totals: Vec<u32>,
}

/// A checkpoint adds at most 113 cells (the score disc) at `CAP` per source,
/// and a run has at most `BURN_TICKS / SCORE_EVERY + 1` checkpoints, so
/// `totals` fits in u32.
const _: () = assert!(113 * CAP as u64 * (BURN_TICKS / SCORE_EVERY + 1) as u64 <= u32::MAX as u64);

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
            if let Some(&x) = r.iter().find(|&&x| x > RICH_MAX) {
                return Err(Error::BadRichness(x));
            }
        }
        if ticks > BURN_TICKS {
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

        let ah = (0..ants).map(|_| (rng.next() & 15) as u8).collect();
        let food = food_grid(&sx, &sy);
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
            food,
            val: vec![0; (W * H) as usize],
            last: vec![0; (W * H) as usize],
            ax: vec![(NEST_X * 256 + 128) as u16; ants],
            ay: vec![(NEST_Y * 256 + 128) as u16; ants],
            ah,
            returning: vec![false; ants],
            strength: vec![0; ants],
            totals: vec![0; n],
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
            let mut h = self.ah[a] as i32;
            let mut x = self.ax[a] as i32;
            let mut y = self.ay[a] as i32;

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
                h = home_heading(nest_tx - x, nest_ty - y);
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
                let i = (cy * W + cx) as usize;
                if !self.returning[a] {
                    let s = self.food[i];
                    if s != NO_FOOD {
                        self.returning[a] = true;
                        self.strength[a] =
                            ((DEPOSIT_BASE * self.rich[s as usize] as i32) >> 8) as u16;
                        h = (h + 8) & 15;
                    }
                } else {
                    let v = decayed(self.val[i], self.last[i], t) + self.strength[a] as u32;
                    self.val[i] = v.min(CAP) as u16;
                    self.last[i] = t;
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

            self.ah[a] = h as u8;
            self.ax[a] = x as u16;
            self.ay[a] = y as u16;
        }
        if t % SCORE_EVERY == 0 || t == self.ticks {
            let now = self.scores();
            for (acc, v) in self.totals.iter_mut().zip(now) {
                *acc += v;
            }
        }
        true
    }

    /// Compact encoding for contract storage (about 15 KB for 150 ants):
    /// big-endian, every field in its narrowest width. `food` is not stored;
    /// `from_bytes` rebuilds it from the sources. Each cell's `last` is stored
    /// as its age, `t - last`, capped at `FADE_TICKS`: past that the cell has
    /// decayed to 0 either way, so the cap doesn't change any later tick.
    pub fn to_bytes(&self) -> Vec<u8> {
        let cells = (W * H) as usize;
        let mut b = Vec::with_capacity(STATE_HEAD + 9 * self.n + 4 * cells + 7 * self.ants);
        b.push(STATE_FORMAT);
        for w in self.rng.s {
            b.extend_from_slice(&w.to_be_bytes());
        }
        b.extend_from_slice(&self.seed);
        b.push(self.n as u8);
        b.extend_from_slice(&(self.ants as u16).to_be_bytes());
        b.extend_from_slice(&self.ticks.to_be_bytes());
        b.extend_from_slice(&self.t.to_be_bytes());
        b.extend_from_slice(&self.commit.stake_hash);
        b.extend_from_slice(&self.commit.odds_hash);
        for s in 0..self.n {
            b.extend_from_slice(&[self.sx[s] as u8, self.sy[s] as u8, self.perm[s]]);
            b.extend_from_slice(&self.rich[s].to_be_bytes());
            b.extend_from_slice(&self.totals[s].to_be_bytes());
        }
        for v in &self.val {
            b.extend_from_slice(&v.to_be_bytes());
        }
        for &l in &self.last {
            let age = ((self.t - l) as usize).min(FADE_TICKS) as u16;
            b.extend_from_slice(&age.to_be_bytes());
        }
        for a in 0..self.ants {
            b.extend_from_slice(&self.ax[a].to_be_bytes());
            b.extend_from_slice(&self.ay[a].to_be_bytes());
            b.extend_from_slice(&self.strength[a].to_be_bytes());
            b.push(self.ah[a] | (self.returning[a] as u8) << 7);
        }
        b
    }

    /// Inverse of `to_bytes`. Checks the layout, not that the state is reachable.
    pub fn from_bytes(b: &[u8]) -> Result<Colony, Error> {
        let mut r = Reader { b, at: 0 };
        if r.u8()? != STATE_FORMAT {
            return Err(Error::BadState);
        }
        let mut s = [0u32; 4];
        for w in s.iter_mut() {
            *w = r.u32()?;
        }
        let seed = r.arr32()?;
        let n = r.u8()? as usize;
        let ants = r.u16()? as usize;
        let ticks = r.u32()?;
        let t = r.u32()?;
        if !(2..=5).contains(&n) || ticks > BURN_TICKS || t > ticks {
            return Err(Error::BadState);
        }
        let commit = Commit {
            stake_hash: r.arr32()?,
            odds_hash: r.arr32()?,
        };
        let (mut sx, mut sy, mut perm, mut rich, mut totals) =
            (vec![], vec![], vec![], vec![], vec![]);
        for _ in 0..n {
            sx.push(r.u8()? as i32);
            sy.push(r.u8()? as i32);
            perm.push(r.u8()?);
            rich.push(r.u16()?);
            totals.push(r.u32()?);
        }
        if sx.iter().any(|&x| x >= W) || sy.iter().any(|&y| y >= H) {
            return Err(Error::BadState);
        }
        let cells = (W * H) as usize;
        let val = (0..cells).map(|_| r.u16()).collect::<Result<Vec<_>, _>>()?;
        let mut last = Vec::with_capacity(cells);
        for _ in 0..cells {
            let age = r.u16()? as u32;
            if age as usize > FADE_TICKS || age > t {
                return Err(Error::BadState);
            }
            last.push(t - age);
        }
        let (mut ax, mut ay, mut strength, mut ah, mut returning) =
            (vec![], vec![], vec![], vec![], vec![]);
        for _ in 0..ants {
            ax.push(r.u16()?);
            ay.push(r.u16()?);
            strength.push(r.u16()?);
            let f = r.u8()?;
            ah.push(f & 15);
            returning.push(f >> 7 == 1);
        }
        if r.at != b.len() {
            return Err(Error::BadState);
        }
        Ok(Colony {
            rng: Rng { s },
            seed,
            n,
            ants,
            ticks,
            t,
            commit,
            food: food_grid(&sx, &sy),
            sx,
            sy,
            rich,
            perm,
            totals,
            val,
            last,
            ax,
            ay,
            ah,
            returning,
            strength,
        })
    }

    /// Pheromone in cell `i` at the current tick (lazy evaporation).
    pub fn cell(&self, i: usize) -> u32 {
        decayed(self.val[i], self.last[i], self.t)
    }

    /// Pheromone within the score radius of each source, at the current tick.
    /// The result scores `totals`, this summed at every checkpoint.
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
        let scores = self.totals.clone();
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
/// stakes), `Agents` reads `agent_odds` (the forecaster agents' median odds)
/// and the others read the odds snapshot. Every forecaster commits the stake
/// snapshot hash; the second commitment is the odds snapshot hash, except for
/// `Agents`, which commits `agent_hash` (the agent-odds snapshot) instead.
#[allow(clippy::too_many_arguments)]
pub fn forecast_run(
    seed: &[u8; 32],
    kind: Kind,
    odds: &[u16],
    odds_6h: &[u16],
    weights: &[u32],
    stake_hash: [u8; 32],
    agent_odds: &[u16],
    agent_hash: [u8; 32],
    ants: usize,
    ticks: u32,
) -> Result<SimResult, Error> {
    let mut odds_hash = odds_snapshot_hash(odds, odds_6h)?;
    let rich = match kind {
        Kind::Community => {
            if weights.len() != odds.len() {
                return Err(Error::BadWeights);
            }
            stake_richness(weights)?
        }
        Kind::Agents => {
            if agent_odds.len() != odds.len() {
                return Err(Error::BadOdds);
            }
            odds_hash = agent_hash;
            agent_richness(agent_odds)?
        }
        _ => odds_richness(kind, odds, odds_6h)?,
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

/// The five forecasters of one market combined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketResult {
    pub colony: u16,
    /// One run per kind, in `KINDS` order.
    pub colonies: Vec<SimResult>,
    /// Which runs count in the swarm belief (`voters`), in `KINDS` order.
    pub counted: [bool; 5],
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

/// Which of the five forecasters (`KINDS` order) count in the swarm belief. A
/// colony with no input abstains: Community when nobody staked on the market,
/// Agents when no agent posted. It still runs, on an even map, and its hash is
/// still committed; an even map is not a belief.
pub fn voters(weights: &[u32], agent_odds: &[u16]) -> [bool; 5] {
    [
        true,
        true,
        true,
        weights.iter().any(|&x| x > 0),
        agent_odds.iter().any(|&o| o > 0),
    ]
}

/// Combine the five forecaster runs (in `KINDS` order) of one market.
/// `counted` comes from `voters`. Swarm belief per option is the floored mean
/// of the counted colonies' trail shares; the remainder goes to the option
/// with the largest sum (lowest index on ties).
/// Market hash = sha256(tag, colony u16, n u8, five colony hashes, swarm u16 each).
pub fn market_result(
    colony: u16,
    runs: Vec<SimResult>,
    counted: [bool; 5],
) -> Result<MarketResult, Error> {
    if runs.len() != KINDS.len() || !(counted[0] && counted[1] && counted[2]) {
        return Err(Error::BadMarketRuns);
    }
    let n = runs[0].perm.len();
    if runs.iter().any(|r| r.perm.len() != n) {
        return Err(Error::BadMarketRuns);
    }
    let shares: Vec<Vec<u16>> = runs.iter().map(trail_shares).collect();
    let k = counted.iter().filter(|&&c| c).count() as u64;
    let sums: Vec<u64> = (0..n)
        .map(|o| {
            shares
                .iter()
                .zip(counted)
                .filter(|(_, c)| *c)
                .map(|(s, _)| s[o] as u64)
                .sum()
        })
        .collect();
    let mut swarm: Vec<u64> = sums.iter().map(|&x| x / k).collect();
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
        counted,
        shares,
        swarm,
        hash: sha256(&buf),
    })
}

/// The five forecasters on one market, each on its own map. `colony` is the
/// market's colony id (`market_colony(m)`); `weights` are that colony's stake
/// weights, one per outcome (zeros when nobody staked); `agent_odds` and
/// `agent_hash` are the forecaster agents' per-outcome median odds and the
/// agent-odds snapshot hash (zeros when no agent posted).
#[allow(clippy::too_many_arguments)]
pub fn forecast_market(
    round_seed: &[u8; 32],
    colony: u16,
    odds: &[u16],
    odds_6h: &[u16],
    weights: &[u32],
    stake_hash: [u8; 32],
    agent_odds: &[u16],
    agent_hash: [u8; 32],
    ants: usize,
    ticks: u32,
) -> Result<MarketResult, Error> {
    let runs = KINDS
        .iter()
        .map(|&k| {
            let seed = colony_seed(round_seed, colony, k as u8);
            forecast_run(
                &seed, k, odds, odds_6h, weights, stake_hash, agent_odds, agent_hash, ants, ticks,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    market_result(colony, runs, voters(weights, agent_odds))
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
            "8cee35da6b2f5b81f5d85e7a030991ab3760c3b21357899957716a10009c6b9e"
        );
        assert_eq!(r.winner_option, 1);
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
            Colony::new(&seed, 3, None, 10, BURN_TICKS + 1).unwrap_err(),
            Error::TooManyTicks(BURN_TICKS + 1)
        );
    }

    #[test]
    fn odds_richness_matches_reference() {
        // Values printed by antosim.odds_richness in the Python reference.
        let (o, p) = ([9000, 1000], [8000, 2000]);
        assert_eq!(
            odds_richness(Kind::Follower, &o, &p).unwrap(),
            vec![334, 37]
        );
        assert_eq!(
            odds_richness(Kind::Contrarian, &o, &p).unwrap(),
            vec![37, 334]
        );
        assert_eq!(odds_richness(Kind::Momentum, &o, &p).unwrap(), vec![334, 6]);
        assert_eq!(stake_richness(&[0, 0, 0]).unwrap(), vec![334, 334, 334]);
        assert_eq!(
            agent_richness(&[4500, 4000, 1500]).unwrap(),
            vec![334, 296, 111]
        );
        // No agent posted: an even map.
        assert_eq!(agent_richness(&[0, 0, 0]).unwrap(), vec![334, 334, 334]);
        assert_eq!(agent_richness(&[0, 10000]).unwrap(), vec![0, 334]);
        assert_eq!(stake_richness(&[20000, 0]).unwrap(), vec![334, 117]);
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
        assert_eq!(odds_richness(Kind::Agents, &ok, &ok), Err(Error::BadOdds));
        assert_eq!(agent_richness(&[10001, 0]), Err(Error::BadOdds));
        assert_eq!(agent_richness(&[5000]), Err(Error::BadOdds));
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
            forecast_run(&seed, k, o, &odds_6h, &w, h, &[0; 3], [0; 32], 30, 60)
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
        // Agents commits the agent-odds hash, not the market odds.
        let agents = |a: &[u16], h: [u8; 32]| {
            forecast_run(
                &seed,
                Kind::Agents,
                &odds,
                &odds_6h,
                &w,
                [0; 32],
                a,
                h,
                30,
                60,
            )
            .unwrap()
            .hash
        };
        let a = agents(&[0; 3], [0; 32]);
        assert_ne!(a, agents(&[0; 3], [1; 32]));
        assert_ne!(a, agents(&[5000, 4000, 1000], [0; 32]));
        assert_eq!(
            a,
            forecast_run(
                &seed,
                Kind::Agents,
                &[1, 2, 3],
                &[1, 2, 3],
                &w,
                [0; 32],
                &[0; 3],
                [0; 32],
                30,
                60
            )
            .unwrap()
            .hash
        );
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
            &[4500, 4000, 1500],
            sha256(b"agents"),
            FORECAST_ANTS,
            FORECAST_TICKS,
        )
        .unwrap();
        assert_eq!(
            r.shares,
            vec![
                vec![4888, 3961, 1151],
                vec![3355, 2570, 4075],
                vec![7146, 1674, 1180],
                vec![1586, 4171, 4243],
                vec![3767, 4259, 1974]
            ]
        );
        assert_eq!(r.counted, [true; 5]);
        assert_eq!(r.swarm, vec![4149, 3327, 2524]);
        assert_eq!(
            r.hash_hex(),
            "0022ce64cc5ffcb7bfe85e1f7d003084a99b12e32dc68883e04d7601cfa3e69b"
        );
    }

    #[test]
    fn each_forecaster_gets_its_own_map() {
        let s = seed_from_int(9);
        let seeds: Vec<_> = KINDS.iter().map(|&k| colony_seed(&s, 1, k as u8)).collect();
        for i in 0..5 {
            for j in i + 1..5 {
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
        let runs = vec![mk(vec![1, 2], vec![0, 1], 1); 5];
        let all = [true; 5];
        let m = market_result(1, runs.clone(), all).unwrap();
        assert_eq!(m.swarm, vec![3333, 6667]);
        assert_eq!(
            market_result(1, runs[..4].to_vec(), all),
            Err(Error::BadMarketRuns)
        );
        // Abstaining colonies don't count: three 1:2 runs and two 1:1 runs.
        let mut mixed = runs.clone();
        mixed[3] = mk(vec![1, 1], vec![0, 1], 0);
        mixed[4] = mk(vec![1, 1], vec![0, 1], 0);
        let three = [true, true, true, false, false];
        assert_eq!(
            market_result(1, mixed.clone(), three).unwrap().swarm,
            vec![3333, 6667]
        );
        assert_eq!(
            market_result(1, mixed.clone(), all).unwrap().swarm,
            vec![3999, 6001]
        );
        // Follower, Contrarian and Momentum always count.
        assert_eq!(
            market_result(1, mixed, [false, true, true, true, true]),
            Err(Error::BadMarketRuns)
        );
        assert_eq!(voters(&[0, 0], &[0, 0]), three);
        assert_eq!(voters(&[0, 1], &[0, 0]), [true, true, true, true, false]);
        assert_eq!(
            voters(&[0, 0], &[3000, 7000]),
            [true, true, true, false, true]
        );
    }

    /// The spec's rule: scan all 16 headings, lowest index on ties.
    fn home_heading_scan(dx: i32, dy: i32) -> i32 {
        let mut best = i32::MIN;
        let mut bk = 0;
        for k in 0..16 {
            let dot = DX[k] * dx + DY[k] * dy;
            if k == 0 || dot > best {
                best = dot;
                bk = k;
            }
        }
        bk as i32
    }

    #[test]
    fn home_heading_matches_full_scan() {
        // Every (dx, dy) a returning ant can have: positions are Q8 inside the grid.
        let (tx, ty) = (NEST_X * 256 + 128, NEST_Y * 256 + 128);
        for x in 0..W * 256 {
            let dx = tx - x;
            for y in 0..H * 256 {
                let dy = ty - y;
                assert_eq!(home_heading(dx, dy), home_heading_scan(dx, dy), "{dx} {dy}");
            }
        }
    }

    #[test]
    fn food_grid_matches_per_source_scan() {
        for i in 0..200 {
            let c = Colony::new(&seed_from_int(i), 2 + (i % 4) as usize, None, 1, 1).unwrap();
            for cy in 0..H {
                for cx in 0..W {
                    let want = (0..c.n)
                        .find(|&s| {
                            let (ddx, ddy) = (cx - c.sx[s], cy - c.sy[s]);
                            ddx * ddx + ddy * ddy <= FOOD_RADIUS_SQ
                        })
                        .map_or(NO_FOOD, |s| s as u8);
                    assert_eq!(c.food[(cy * W + cx) as usize], want);
                }
            }
        }
    }

    #[test]
    fn stored_colony_resumes_identically() {
        let seed = seed_from_int(11);
        let whole = run(&seed, 5, None, N_ANTS, TICKS).unwrap();
        let mut c = Colony::new(&seed, 5, None, N_ANTS, TICKS).unwrap();
        let mut sizes = vec![];
        while c.t < c.ticks {
            for _ in 0..100 {
                c.step();
            }
            let b = c.to_bytes();
            sizes.push(b.len());
            c = Colony::from_bytes(&b).unwrap();
        }
        assert_eq!(c.result().unwrap(), whole);
        assert!(sizes.iter().all(|&s| s == 15_043), "{sizes:?}");
        let b = c.to_bytes();
        assert_eq!(
            Colony::from_bytes(&b[..b.len() - 1]).unwrap_err(),
            Error::BadState
        );
        let mut extra = b.clone();
        extra.push(0);
        assert_eq!(Colony::from_bytes(&extra).unwrap_err(), Error::BadState);
    }

    #[test]
    fn richness_above_the_band_is_rejected() {
        let seed = seed_from_int(0);
        assert!(Colony::new(&seed, 2, Some(&[RICH_MAX, 0]), 10, 10).is_ok());
        assert_eq!(
            Colony::new(&seed, 2, Some(&[RICH_MAX + 1, 0]), 10, 10).unwrap_err(),
            Error::BadRichness(RICH_MAX + 1)
        );
    }

    #[test]
    fn decay_table_matches_reference_endpoints() {
        assert_eq!(DECAY_T[0], 65536);
        assert_eq!(DECAY_T[1], 65012);
        assert_eq!(FADE_TICKS, 852);
        assert!(DECAY_T[FADE_TICKS - 1] > 0);
        assert_eq!(DECAY_T[FADE_TICKS], 0);
    }

    #[test]
    fn long_run_resumes_identically_past_the_fade() {
        // Saves every 997 ticks, so stored ages hit the FADE_TICKS cap and
        // cells untouched since before the last save decay correctly.
        let seed = seed_from_int(12);
        let ticks = 6 * FADE_TICKS as u32;
        let whole = run(&seed, 5, None, 40, ticks).unwrap();
        let mut c = Colony::new(&seed, 5, None, 40, ticks).unwrap();
        while c.t < c.ticks {
            for _ in 0..997 {
                c.step();
            }
            let b = c.to_bytes();
            c = Colony::from_bytes(&b).unwrap();
            assert_eq!(c.to_bytes(), b);
        }
        assert_eq!(c.result().unwrap(), whole);
    }

    #[test]
    fn stored_ages_are_checked() {
        let mut c = Colony::new(&seed_from_int(3), 2, None, 1, 10).unwrap();
        c.step();
        let mut b = c.to_bytes();
        let at = STATE_HEAD + 9 * 2 + 2 * (W * H) as usize; // first cell's age
        assert_eq!(&b[at..at + 2], &[0, 1]);
        b[at + 1] = 2; // older than the run
        assert_eq!(Colony::from_bytes(&b).unwrap_err(), Error::BadState);
    }
}
