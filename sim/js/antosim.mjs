// Antonomy simulation, JS port of sim/python/antosim.py (spec v1).
// Must match the Python reference bit for bit. Integer arithmetic only.
// Runs unchanged in Node and in the browser: SHA-256 is implemented below,
// the tables come in as a JSON module, and bytes are plain Uint8Arrays.
import T from "../tables.json" with { type: "json" };

export const W = 72, H = 48;
export const NEST_X = 36, NEST_Y = 24;
export const N_ANTS = 150;
export const TICKS = 800;
export const BURN_TICKS = 43200; // Burn colony: 12:00 to 24:00 UTC at one tick per second; the longest run
export const CAP = 20 * 256;
const DECAY_Q16 = 65536 - 524;
const SENSE_DIST = 3;
const WANDER = 64;
const DEPOSIT_BASE = 512;
export const FOOD_RADIUS_SQ = 4;
const NEST_RADIUS_SQ = 4;
export const SCORE_RADIUS_SQ = 36;
const RICH_MIN = 90, RICH_SPAN = 244; // richness Q8: 0.35 .. 1.3
export const SCORE_EVERY = 100; // ticks between score checkpoints
const DIST_MIN = 9, DIST_SPAN = 13;
const MARGIN = 4;

const enc = new TextEncoder();
export const SIM_VERSION = "ANTO-SIM-v1";
const VERSION = enc.encode(SIM_VERSION);

// Snapshot inputs (see sim/python/antosim.py for the rationale).
const BPS = 10000;
const MOMENTUM_FLOOR = 200;
const COMMUNITY_BASE = 2500; // milli sqrt-tokens
const ODDS_TAG = enc.encode("ANTO-ODDS-v0");
const ZERO32 = new Uint8Array(32);
export const FOLLOWER = 0, CONTRARIAN = 1, MOMENTUM = 2, COMMUNITY = 3;
export const KINDS = [FOLLOWER, CONTRARIAN, MOMENTUM, COMMUNITY];

// --- Forecast colonies ---
export const FORECAST_ANTS = 60, FORECAST_TICKS = 300;
// Colony ids match the staking colony ids: 0 = Burn, 1 + m = market m of the round.
export const BURN_COLONY = 0;
const COLONY_TAG = enc.encode("ANTO-COLONY-v0");
const MARKET_TAG = enc.encode("ANTO-MARKET-v0");

const COS64 = T.cos64, SIN64 = T.sin64;
export const DX = Array.from({ length: 16 }, (_, k) => COS64[k * 4]);
export const DY = Array.from({ length: 16 }, (_, k) => SIN64[k * 4]);

// Lazy evaporation: DECAY_T[n] = retention factor (Q16) after n ticks. It
// reaches 0 at n = FADE_TICKS (852); retention for every n >= FADE_TICKS is 0.
const DECAY_T = [65536];
while (DECAY_T[DECAY_T.length - 1]) DECAY_T.push(Math.floor((DECAY_T[DECAY_T.length - 1] * DECAY_Q16) / 65536));
export const FADE_TICKS = DECAY_T.length - 1;
const decay = (age) => DECAY_T[age < FADE_TICKS ? age : FADE_TICKS];

// ---- Bytes and SHA-256 (FIPS 180-4) ----

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const ror = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256(msg) {
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(padded.length - 4, (len << 3) >>> 0);
  const hs = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ror(x, 7) ^ ror(x, 18) ^ (x >>> 3);
      const s1 = ror(y, 17) ^ ror(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = hs[0], b = hs[1], c = hs[2], d = hs[3], e = hs[4], f = hs[5], g = hs[6], h = hs[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    hs[0] += a; hs[1] += b; hs[2] += c; hs[3] += d;
    hs[4] += e; hs[5] += f; hs[6] += g; hs[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, hs[i]);
  return out;
}

function scaleRichness(weights) {
  const top = Math.max(...weights);
  if (!(top > 0)) throw new RangeError("all food weights are zero");
  return weights.map((w) => RICH_MIN + Math.floor((RICH_SPAN * Math.floor((w * BPS) / top)) / BPS));
}

function checkOdds(odds, odds6h) {
  if (odds.length < 2 || odds.length > 5 || odds6h.length !== odds.length) throw new RangeError("bad odds length");
  for (const o of [...odds, ...odds6h]) if (!Number.isInteger(o) || o < 0 || o > BPS) throw new RangeError("odds out of range");
}

// Per-option Q8 richness for Follower, Contrarian or Momentum. odds and odds6h
// are basis points per outcome now and six hours ago.
export function oddsRichness(kind, odds, odds6h) {
  checkOdds(odds, odds6h);
  let w;
  if (kind === FOLLOWER) w = [...odds];
  else if (kind === CONTRARIAN) w = odds.map((o) => Math.floor((BPS - o) / 4));
  else if (kind === MOMENTUM) w = odds.map((o, i) => Math.max(o + 2 * (o - odds6h[i]), MOMENTUM_FLOOR));
  else throw new RangeError("kind must be FOLLOWER, CONTRARIAN or MOMENTUM");
  return scaleRichness(w);
}

// Per-option Q8 richness from stake weights (Burn and Community colonies):
// per option, the sum over wallets of sqrt(tokens staked) in milli-units, each < 2^32.
export function stakeRichness(weights) {
  if (weights.length < 2 || weights.length > 5) throw new RangeError("bad weights length");
  for (const x of weights) if (!Number.isInteger(x) || x < 0 || x > 0xffffffff) throw new RangeError("stake weight out of u32 range");
  return scaleRichness(weights.map((x) => COMMUNITY_BASE + x));
}

// Hash of the odds snapshot: the second input commitment in the result hash.
export function oddsSnapshotHash(odds, odds6h) {
  checkOdds(odds, odds6h);
  const body = [odds.length];
  for (const o of [...odds, ...odds6h]) body.push(o >> 8, o & 255);
  return sha256(concat([ODDS_TAG, Uint8Array.from(body)]));
}

const i32be = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

class Rng {
  constructor(seed) {
    const h = sha256(concat([enc.encode("ANTO-RNG-v0"), seed]));
    this.s0 = i32be(h, 0);
    this.s1 = i32be(h, 4);
    this.s2 = i32be(h, 8);
    this.s3 = i32be(h, 12);
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }
  next() {
    let { s0, s1, s2, s3 } = this;
    let x = Math.imul(s1, 5);
    x = (x << 7) | (x >>> 25);
    const result = Math.imul(x, 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
    return result;
  }
}

// One colony, advanced one tick at a time. run() below is the whole sim;
// the replay page uses the same class to draw every tick. All state fields
// are public and read-only for callers.
export class Colony {
  // richness: optional per-option Q8 values replacing the seed-derived ones.
  // stakeHash, oddsHash: 32-byte snapshot hashes committed in the result hash.
  constructor(seed, n = 5, richness = null, ants = N_ANTS, ticks = TICKS, stakeHash = ZERO32, oddsHash = ZERO32) {
    if (seed.length !== 32 || n < 2 || n > 5 || stakeHash.length !== 32 || oddsHash.length !== 32) throw new Error("bad args");
    if (richness !== null && richness.length !== n) throw new Error("bad args");
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > BURN_TICKS) throw new RangeError("ticks out of range");
    // The richness band's top; the Rust port stores deposit strength (2x) in a u16.
    if (richness !== null && !richness.every((r) => Number.isInteger(r) && r >= 0 && r <= RICH_MIN + RICH_SPAN)) {
      throw new RangeError("richness out of band");
    }
    this.stakeHash = stakeHash;
    this.oddsHash = oddsHash;
    const rng = new Rng(seed);
    this.rng = rng;
    this.seed = seed;
    this.n = n;
    this.ants = ants;
    this.ticks = ticks;
    this.t = 0;

    const sx = [], sy = [];
    for (let i = 0; i < n; i++) {
      const idx = (Math.floor((i * 64) / n) + (rng.next() % 8) - 4) & 63;
      const dist = DIST_MIN + (rng.next() % DIST_SPAN);
      const fx = NEST_X + ((COS64[idx] * dist) >> 8);
      const fy = NEST_Y + ((SIN64[idx] * dist) >> 8);
      sx.push(Math.min(Math.max(fx, MARGIN), W - 1 - MARGIN));
      sy.push(Math.min(Math.max(fy, MARGIN), H - 1 - MARGIN));
    }
    const rich = [];
    for (let i = 0; i < n; i++) rich.push(RICH_MIN + (rng.next() % RICH_SPAN));

    // perm[option] = source index holding that option
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = rng.next() % (i + 1);
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    // Supplied richness belongs to options, so it follows the shuffle.
    if (richness !== null) for (let o = 0; o < n; o++) rich[perm[o]] = richness[o];
    this.sx = sx; this.sy = sy; this.rich = rich; this.perm = perm;

    this.val = new Uint32Array(W * H);
    this.last = new Uint32Array(W * H);
    this.ax = new Int32Array(ants).fill(NEST_X * 256 + 128);
    this.ay = new Int32Array(ants).fill(NEST_Y * 256 + 128);
    this.ah = new Int32Array(ants);
    for (let a = 0; a < ants; a++) this.ah[a] = rng.next() & 15;
    this.returning = new Uint8Array(ants);
    this.strength = new Int32Array(ants);
    // Score per source so far: scores() summed at every checkpoint.
    this.totals = new Array(n).fill(0);
  }

  // Advance one tick. Returns false once the final tick has run.
  step() {
    if (this.t >= this.ticks) return false;
    const t = ++this.t;
    const { rng, n, ants, sx, sy, rich, val, last, ax, ay, ah, returning, strength } = this;
    const nestTx = NEST_X * 256 + 128, nestTy = NEST_Y * 256 + 128;

    for (let a = 0; a < ants; a++) {
      const r = rng.next();
      const wander = (r & 255) < WANDER;
      const turn = ((r >>> 8) & 255) % 3 - 1;
      let h = ah[a], x = ax[a], y = ay[a];

      if (!returning[a]) {
        let best = -1, bh = h;
        for (const d of [0, -1, 1]) {
          const hh = (h + d) & 15;
          const cx = (x + DX[hh] * SENSE_DIST) >> 8;
          const cy = (y + DY[hh] * SENSE_DIST) >> 8;
          let v = 0;
          if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
            const i = cy * W + cx;
            v = Math.floor((val[i] * decay(t - last[i])) / 65536);
          }
          if (v > best) { best = v; bh = hh; }
        }
        h = bh;
      } else {
        const dx = nestTx - x, dy = nestTy - y;
        let best = null, bk = 0;
        for (let k = 0; k < 16; k++) {
          const dot = DX[k] * dx + DY[k] * dy;
          if (best === null || dot > best) { best = dot; bk = k; }
        }
        h = bk;
      }

      if (wander) h = (h + turn) & 15;

      const nx = x + DX[h], ny = y + DY[h];
      const cx = nx >> 8, cy = ny >> 8;
      if (cx < 0 || cx >= W || cy < 0 || cy >= H) {
        h = (h + 8) & 15;
      } else {
        x = nx; y = ny;
        if (!returning[a]) {
          for (let s = 0; s < n; s++) {
            const ddx = cx - sx[s], ddy = cy - sy[s];
            if (ddx * ddx + ddy * ddy <= FOOD_RADIUS_SQ) {
              returning[a] = 1;
              strength[a] = (DEPOSIT_BASE * rich[s]) >> 8;
              h = (h + 8) & 15;
              break;
            }
          }
        } else {
          const i = cy * W + cx;
          const v = Math.floor((val[i] * decay(t - last[i])) / 65536) + strength[a];
          val[i] = v > CAP ? CAP : v;
          last[i] = t;
          strength[a] -= strength[a] >> 5;
          const ddx = cx - NEST_X, ddy = cy - NEST_Y;
          if (ddx * ddx + ddy * ddy <= NEST_RADIUS_SQ) {
            returning[a] = 0;
            strength[a] = 0;
            h = (h + 8) & 15;
          }
        }
      }
      ah[a] = h; ax[a] = x; ay[a] = y;
    }
    if (t % SCORE_EVERY === 0 || t === this.ticks) {
      const now = this.scores();
      for (let s = 0; s < n; s++) this.totals[s] += now[s];
    }
    return true;
  }

  // An independent copy at the same tick, for seek points in a long replay.
  // Stepping the copy gives the same ticks and result as stepping this one.
  clone() {
    const c = Object.create(Colony.prototype);
    for (const [k, v] of Object.entries(this)) c[k] = ArrayBuffer.isView(v) || Array.isArray(v) ? v.slice() : v;
    c.rng = Object.assign(Object.create(Rng.prototype), this.rng);
    return c;
  }

  // Pheromone in cell i at the current tick (lazy evaporation).
  cell(i) {
    return Math.floor((this.val[i] * decay(this.t - this.last[i])) / 65536);
  }

  // Pheromone within the score radius of each source, at the current tick.
  // The result scores `totals`, this summed at every checkpoint.
  scores() {
    const { n, sx, sy } = this;
    const out = [];
    for (let s = 0; s < n; s++) {
      let total = 0;
      for (let yy = sy[s] - 6; yy <= sy[s] + 6; yy++) {
        for (let xx = sx[s] - 6; xx <= sx[s] + 6; xx++) {
          const ddx = xx - sx[s], ddy = yy - sy[s];
          if (ddx * ddx + ddy * ddy <= SCORE_RADIUS_SQ && xx >= 0 && xx < W && yy >= 0 && yy < H) {
            total += this.cell(yy * W + xx);
          }
        }
      }
      out.push(total);
    }
    return out;
  }

  // Each source's score if the run ended now: `totals`, plus the current
  // trail unless this tick was a checkpoint (the final tick always is). Equals
  // result().scores at the last tick. For display; reads state only.
  standing() {
    const t = this.t;
    if (t === 0 || t % SCORE_EVERY === 0 || t === this.ticks) return this.totals.slice();
    return this.scores().map((v, s) => this.totals[s] + v);
  }

  // Final result and hash. Only valid after the last tick.
  result() {
    if (this.t !== this.ticks) throw new Error("colony not finished");
    const { n, sx, sy, rich, perm } = this;
    const scores = this.totals.slice();

    let winSrc = 0;
    for (let s = 1; s < n; s++) if (scores[s] > scores[winSrc]) winSrc = s;
    const winOpt = perm.indexOf(winSrc);

    const parts = [VERSION, this.seed, Uint8Array.of(n), this.stakeHash, this.oddsHash];
    for (let s = 0; s < n; s++) {
      if (!(rich[s] >= 0 && rich[s] <= 0xffff)) throw new RangeError("richness out of u16 range");
      parts.push(Uint8Array.of(sx[s], sy[s], rich[s] >> 8, rich[s] & 255));
    }
    for (let s = 0; s < n; s++) {
      const v = scores[s];
      if (!(v >= 0 && v <= 0xffffffff)) throw new RangeError("score out of u32 range");
      parts.push(Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
    }
    parts.push(Uint8Array.of(winSrc), Uint8Array.from(perm));
    return {
      winner_source: winSrc,
      winner_option: winOpt,
      scores,
      perm,
      sources: sx.map((_, s) => [sx[s], sy[s], rich[s]]),
      hash: toHex(sha256(concat(parts))),
    };
  }
}

export function run(seed, n = 5, richness = null, ants = N_ANTS, ticks = TICKS, stakeHash = ZERO32, oddsHash = ZERO32) {
  const c = new Colony(seed, n, richness, ants, ticks, stakeHash, oddsHash);
  while (c.step());
  return c.result();
}

// Burn colony: five menu options, richness from the Burn colony's stakes.
export function burnRun(seed, weights, stakeHash, ants = N_ANTS, ticks = TICKS) {
  return run(seed, 5, stakeRichness(weights), ants, ticks, stakeHash);
}

// One forecaster on one market. Community reads `weights` (that market's
// stakes); the others read the odds snapshot.
export function forecastRun(seed, kind, odds, odds6h, weights = null, stakeHash = ZERO32, ants = N_ANTS, ticks = TICKS) {
  let rich;
  if (kind === COMMUNITY) {
    if (weights === null || weights.length !== odds.length) throw new RangeError("Community needs one stake weight per outcome");
    rich = stakeRichness(weights);
  } else {
    rich = oddsRichness(kind, odds, odds6h);
  }
  return run(seed, odds.length, rich, ants, ticks, stakeHash, oddsSnapshotHash(odds, odds6h));
}

// Colony id (and staking colony id) of market m in the round.
export function marketColony(m) {
  if (!Number.isInteger(m) || m < 0 || m >= 0xffff) throw new RangeError("bad market index");
  return 1 + m;
}

// Seed for one colony's map: the round seed, the colony id and the forecaster
// slot (the kind; 0 for the Burn colony).
export function colonySeed(roundSeed, colony, slot = 0) {
  if (roundSeed.length !== 32 || !(colony >= 0 && colony <= 0xffff) || !(slot >= 0 && slot <= 255)) throw new RangeError("bad args");
  return sha256(concat([COLONY_TAG, roundSeed, Uint8Array.of(colony >> 8, colony & 255, slot)]));
}

// Per-option trail share in basis points, summing to exactly 10000. Each share
// is floored; the remainder goes to the winning option. With no trail at all
// every option gets an even share (remainder to the winner).
export function trailShares(result) {
  const scores = result.perm.map((s) => result.scores[s]);
  const n = scores.length, total = scores.reduce((a, b) => a + b, 0);
  const shares = total ? scores.map((x) => Math.floor((x * BPS) / total)) : scores.map(() => Math.floor(BPS / n));
  shares[result.winner_option] += BPS - shares.reduce((a, b) => a + b, 0);
  return shares;
}

// Combine the four forecaster runs (in KINDS order) of one market. Swarm belief
// per option is the floored mean of the four trail shares; the remainder goes
// to the option with the largest sum (lowest index on ties).
// Market hash = sha256(tag, colony u16, n u8, four colony hashes, swarm u16 each).
export function marketResult(colony, runs) {
  if (runs.length !== KINDS.length) throw new RangeError("need one run per kind");
  const shares = runs.map(trailShares);
  const n = shares[0].length;
  const sums = Array.from({ length: n }, (_, o) => shares.reduce((a, s) => a + s[o], 0));
  const swarm = sums.map((x) => Math.floor(x / KINDS.length));
  let top = 0;
  for (let o = 1; o < n; o++) if (sums[o] > sums[top]) top = o;
  swarm[top] += BPS - swarm.reduce((a, b) => a + b, 0);
  const parts = [MARKET_TAG, Uint8Array.of(colony >> 8, colony & 255, n)];
  for (const r of runs) parts.push(Uint8Array.from(r.hash.match(/../g), (h) => parseInt(h, 16)));
  for (const x of swarm) parts.push(Uint8Array.of(x >> 8, x & 255));
  return {
    colony,
    colonies: runs.map((r, k) => ({ ...r, shares: shares[k] })),
    swarm,
    hash: toHex(sha256(concat(parts))),
  };
}

// The four forecasters on one market, each on its own map. colony: the
// market's colony id (marketColony(m)). weights: that colony's stake weights,
// one per outcome (zeros when nobody staked).
export function forecastMarket(roundSeed, colony, odds, odds6h, weights, stakeHash,
  ants = FORECAST_ANTS, ticks = FORECAST_TICKS) {
  const runs = KINDS.map((k) =>
    forecastRun(colonySeed(roundSeed, colony, k), k, odds, odds6h, weights, stakeHash, ants, ticks));
  return marketResult(colony, runs);
}

export function seedFromInt(i) {
  return sha256(enc.encode(`seed-${i}`));
}
