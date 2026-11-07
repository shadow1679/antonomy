//! Antonomy simulation, Rust port of sim/python/antosim.py (spec v0).
//!
//! Must match the Python reference and the JS port bit for bit. Integer
//! arithmetic only: positions are Q8 fixed point, headings are 16 directions
//! from a lookup table, the PRNG is xoshiro128**. `Colony` advances one tick at
//! a time so a contract can spread a run over several calls; `run` loops it.
//!
//! Not yet implemented (same gaps as the reference): map templates, stake
//! snapshot input, per-colony personality parameters.

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
pub const VERSION: &[u8] = b"ANTO-SIM-v0";

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
    /// `richness`, if given, replaces the seed-derived richness (forecast
    /// colonies). The seed draws are still made so the stream stays aligned.
    pub fn new(
        seed: &[u8; 32],
        n: usize,
        richness: Option<&[u16]>,
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
        let mut rich = Vec::with_capacity(n);
        for i in 0..n {
            let drawn = (RICH_MIN + rng.next() % RICH_SPAN) as u16;
            rich.push(richness.map_or(drawn, |r| r[i]));
        }

        let mut perm: Vec<u8> = (0..n as u8).collect();
        for i in (1..n).rev() {
            let j = (rng.next() % (i as u32 + 1)) as usize;
            perm.swap(i, j);
        }

        let ah = (0..ants).map(|_| (rng.next() & 15) as i32).collect();
        Ok(Colony {
            rng,
            seed: *seed,
            n,
            ants,
            ticks,
            t: 0,
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
            "e280b5f2bdc3f323efdaf4949dafa26a226d9b173e3636c38f9a4a06cd9b6e94"
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
    fn decay_table_matches_reference_endpoints() {
        assert_eq!(DECAY_T[0], 65536);
        assert_eq!(DECAY_T[1], 65012);
        assert_eq!(DECAY_T.len(), 802);
    }
}
