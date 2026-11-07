"""Antonomy reference simulation (integer only), spec v1.

This is the reference every other implementation (JS replay, Rust contract)
must match bit for bit. No floats anywhere in the simulation: positions are
Q8 fixed point, headings are 16 discrete directions from a lookup table, and
the PRNG is xoshiro128** on 32-bit words.

Inputs besides the seed: per-option food richness, derived from a stake snapshot
(`stake_richness`, Burn and Community colonies) or an odds snapshot
(`odds_richness`, the other forecasters), plus the stake snapshot hash and the
odds snapshot hash, which go into the result hash. `burn_run` and
`forecast_run` are the entry points that wire these together.

Forecast colonies: `forecast_market` runs the four forecasters on one market,
each on its own map (`colony_seed`), turns their scores into trail shares and
averages them into the swarm belief, committed in one market hash.

Scoring: a colony's score per source is the pheromone within 6 cells of it,
summed at a checkpoint every SCORE_EVERY ticks and at the final tick, so a
steady lead adds up over a long run instead of only the last few minutes of
trail counting. With the 0.35..1.3 richness band and a low flat stake base,
stakes steer: on the 43,200-tick Burn colony, 100 tANTO from one wallet on an
option lifts its win rate from 20% to about 52%.

Not yet implemented (see docs/HACKATHON_ROADMAP.md): map templates (walls,
river), per-colony personality parameters.
"""
import hashlib
import json
import os
import struct

# --- Parameters (immutable contract constants in production) ---------------
W, H = 72, 48
NEST_X, NEST_Y = 36, 24
N_ANTS = 150
TICKS = 800
BURN_TICKS = 43200         # Burn colony: 12:00 to 24:00 UTC at one tick per second; the longest run
CAP = 20 * 256              # pheromone cap per cell, Q8
DECAY_Q16 = 65536 - 524     # per-tick retention, ~0.8% evaporation
SENSE_DIST = 3              # cells ahead that a searching ant samples
WANDER = 64                 # out of 256: chance per step of a random turn
DEPOSIT_BASE = 512          # deposit strength at pickup, Q8, times richness
FOOD_RADIUS_SQ = 4          # cells^2
NEST_RADIUS_SQ = 4          # cells^2
SCORE_RADIUS_SQ = 36        # cells^2 (6 cells)
RICH_MIN, RICH_SPAN = 90, 244    # richness Q8: 0.35 .. 1.3
DIST_MIN, DIST_SPAN = 9, 13      # food distance from nest in cells: 9 .. 21
MARGIN = 4                  # food is clamped at least this far from the edge
SCORE_EVERY = 100           # ticks between score checkpoints
VERSION = b"ANTO-SIM-v1"

# --- Snapshot inputs --------------------------------------------------------
BPS = 10000
MOMENTUM_FLOOR = 200        # 2% floor on the Momentum food weight
COMMUNITY_BASE = 2500       # flat food weight per outcome before stakes, milli sqrt-tokens
ODDS_TAG = b"ANTO-ODDS-v0"
ZERO32 = bytes(32)
FOLLOWER, CONTRARIAN, MOMENTUM, COMMUNITY = range(4)
KINDS = (FOLLOWER, CONTRARIAN, MOMENTUM, COMMUNITY)

# --- Forecast colonies ------------------------------------------------------
FORECAST_ANTS = 60          # design doc section 15, scaling option 1
FORECAST_TICKS = 300
BURN_COLONY = 0             # colony ids match the staking colony ids:
                            # 0 = Burn, 1 + m = market m of the round
COLONY_TAG = b"ANTO-COLONY-v0"
MARKET_TAG = b"ANTO-MARKET-v0"

M32 = 0xFFFFFFFF

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tables.json")) as _f:
    _T = json.load(_f)
COS64, SIN64 = _T["cos64"], _T["sin64"]
DX = [COS64[k * 4] for k in range(16)]
DY = [SIN64[k * 4] for k in range(16)]

# Lazy evaporation: DECAY_T[n] = retention factor (Q16) after n ticks. It
# reaches 0 at n = FADE_TICKS (852), so any cell untouched for that long holds
# no pheromone, and retention for every n >= FADE_TICKS is 0.
DECAY_T = [65536]
while DECAY_T[-1]:
    DECAY_T.append((DECAY_T[-1] * DECAY_Q16) >> 16)
FADE_TICKS = len(DECAY_T) - 1


class Rng:
    """xoshiro128**, seeded from sha256(b"ANTO-RNG-v0" + seed)."""

    def __init__(self, seed):
        h = hashlib.sha256(b"ANTO-RNG-v0" + seed).digest()
        self.s0, self.s1, self.s2, self.s3 = struct.unpack(">4I", h[:16])
        if not (self.s0 | self.s1 | self.s2 | self.s3):
            self.s0 = 1

    def next(self):
        s0, s1, s2, s3 = self.s0, self.s1, self.s2, self.s3
        x = (s1 * 5) & M32
        x = ((x << 7) | (x >> 25)) & M32
        result = (x * 9) & M32
        t = (s1 << 9) & M32
        s2 ^= s0
        s3 ^= s1
        s1 ^= s2
        s0 ^= s3
        s2 ^= t
        s3 = ((s3 << 11) | (s3 >> 21)) & M32
        self.s0, self.s1, self.s2, self.s3 = s0, s1, s2, s3
        return result


def _scale_richness(weights):
    """Food weights -> Q8 richness in the 0.35..1.3 band, the richest source on top.

    Scaling by the largest weight makes the result independent of the total, so
    markets whose odds don't sum to exactly 10000 (per-outcome medians) work.
    """
    top = max(weights)
    assert top > 0
    return [RICH_MIN + RICH_SPAN * (w * BPS // top) // BPS for w in weights]


def _check_odds(odds, odds_6h):
    assert 2 <= len(odds) <= 5 and len(odds_6h) == len(odds)
    assert all(0 <= o <= BPS for o in odds + odds_6h)


def odds_richness(kind, odds, odds_6h):
    """Per-option Q8 richness for Follower, Contrarian or Momentum.

    odds, odds_6h: basis points per outcome now and six hours ago.
    """
    odds, odds_6h = list(odds), list(odds_6h)
    _check_odds(odds, odds_6h)
    if kind == FOLLOWER:
        w = odds
    elif kind == CONTRARIAN:
        w = [(BPS - o) // 4 for o in odds]
    elif kind == MOMENTUM:
        w = [max(o + 2 * (o - p), MOMENTUM_FLOOR) for o, p in zip(odds, odds_6h)]
    else:
        raise ValueError("kind must be FOLLOWER, CONTRARIAN or MOMENTUM")
    return _scale_richness(w)


def stake_richness(weights):
    """Per-option Q8 richness from stake weights (Burn and Community colonies).

    weights: per option, the sum over wallets of sqrt(tokens staked) in
    milli-units (token crate: `Staking::sim_weights`), each < 2^32. Every option
    starts from the same flat base, so with no stakes the food is even.
    """
    weights = list(weights)
    assert 2 <= len(weights) <= 5 and all(0 <= x <= M32 for x in weights)
    return _scale_richness([COMMUNITY_BASE + x for x in weights])


def odds_snapshot_hash(odds, odds_6h):
    """Hash of the odds snapshot: the second input commitment in the result hash."""
    odds, odds_6h = list(odds), list(odds_6h)
    _check_odds(odds, odds_6h)
    return hashlib.sha256(
        ODDS_TAG + struct.pack(">B", len(odds)) + struct.pack(">%dH" % (2 * len(odds)), *odds, *odds_6h)
    ).digest()


def run(seed, n=5, richness=None, ants=N_ANTS, ticks=TICKS, stake_hash=None, odds_hash=None):
    """Run one colony.

    seed: 32 bytes. n: number of outcomes (2..5). richness: optional list of n
    Q8 ints, one per option, that replaces the seed-derived richness (forecast
    and Burn colonies). stake_hash, odds_hash: 32-byte snapshot hashes that are
    committed in the result hash (zeros when the colony doesn't read them).
    Returns a dict with the winning option, scores and the result hash.
    """
    stake_hash = ZERO32 if stake_hash is None else stake_hash
    odds_hash = ZERO32 if odds_hash is None else odds_hash
    assert len(seed) == 32 and 2 <= n <= 5
    assert len(stake_hash) == 32 and len(odds_hash) == 32
    assert 0 <= ticks <= BURN_TICKS
    assert richness is None or len(richness) == n
    # The richness band's top; the Rust port stores deposit strength (2x) in a u16.
    assert richness is None or all(0 <= r <= RICH_MIN + RICH_SPAN for r in richness)
    rng = Rng(seed)
    # DECAY_T padded with zeros to the run length, so every age indexes it.
    decay = DECAY_T + [0] * max(0, ticks - FADE_TICKS)

    # Food placement. Draws are always made so the stream stays aligned.
    sx, sy = [], []
    for i in range(n):
        idx = ((i * 64) // n + rng.next() % 8 - 4) & 63
        dist = DIST_MIN + rng.next() % DIST_SPAN
        fx = NEST_X + ((COS64[idx] * dist) >> 8)
        fy = NEST_Y + ((SIN64[idx] * dist) >> 8)
        sx.append(min(max(fx, MARGIN), W - 1 - MARGIN))
        sy.append(min(max(fy, MARGIN), H - 1 - MARGIN))
    rich = [RICH_MIN + rng.next() % RICH_SPAN for _ in range(n)]

    # Seeded shuffle: perm[option] = food source index.
    perm = list(range(n))
    for i in range(n - 1, 0, -1):
        j = rng.next() % (i + 1)
        perm[i], perm[j] = perm[j], perm[i]

    # Supplied richness belongs to options, so it follows the shuffle.
    if richness is not None:
        for o in range(n):
            rich[perm[o]] = richness[o]

    val = [0] * (W * H)
    last = [0] * (W * H)
    ax = [NEST_X * 256 + 128] * ants
    ay = [NEST_Y * 256 + 128] * ants
    ah = [rng.next() & 15 for _ in range(ants)]
    returning = [0] * ants
    strength = [0] * ants
    nest_tx, nest_ty = NEST_X * 256 + 128, NEST_Y * 256 + 128

    def trail_at(t):
        """Pheromone within 6 cells of each source at tick t."""
        out = []
        for s in range(n):
            total = 0
            for yy in range(sy[s] - 6, sy[s] + 7):
                for xx in range(sx[s] - 6, sx[s] + 7):
                    ddx = xx - sx[s]
                    ddy = yy - sy[s]
                    if ddx * ddx + ddy * ddy <= SCORE_RADIUS_SQ and 0 <= xx < W and 0 <= yy < H:
                        i = yy * W + xx
                        total += (val[i] * decay[t - last[i]]) >> 16
            out.append(total)
        return out

    # Score: the trail summed at a checkpoint every SCORE_EVERY ticks and at
    # the final tick, so a steady lead adds up over the run.
    scores = [0] * n

    for t in range(1, ticks + 1):
        for a in range(ants):
            r = rng.next()
            wander = (r & 255) < WANDER
            turn = ((r >> 8) & 255) % 3 - 1
            h = ah[a]
            x = ax[a]
            y = ay[a]

            if not returning[a]:
                best, bh = -1, h
                for d in (0, -1, 1):
                    hh = (h + d) & 15
                    cx = (x + DX[hh] * SENSE_DIST) >> 8
                    cy = (y + DY[hh] * SENSE_DIST) >> 8
                    if 0 <= cx < W and 0 <= cy < H:
                        i = cy * W + cx
                        v = (val[i] * decay[t - last[i]]) >> 16
                    else:
                        v = 0
                    if v > best:
                        best, bh = v, hh
                h = bh
            else:
                dx = nest_tx - x
                dy = nest_ty - y
                best, bk = None, 0
                for k in range(16):
                    dot = DX[k] * dx + DY[k] * dy
                    if best is None or dot > best:
                        best, bk = dot, k
                h = bk

            if wander:
                h = (h + turn) & 15

            nx = x + DX[h]
            ny = y + DY[h]
            cx = nx >> 8
            cy = ny >> 8
            if cx < 0 or cx >= W or cy < 0 or cy >= H:
                h = (h + 8) & 15
            else:
                x, y = nx, ny
                if not returning[a]:
                    for s in range(n):
                        ddx = cx - sx[s]
                        ddy = cy - sy[s]
                        if ddx * ddx + ddy * ddy <= FOOD_RADIUS_SQ:
                            returning[a] = 1
                            strength[a] = (DEPOSIT_BASE * rich[s]) >> 8
                            h = (h + 8) & 15
                            break
                else:
                    i = cy * W + cx
                    v = ((val[i] * decay[t - last[i]]) >> 16) + strength[a]
                    val[i] = CAP if v > CAP else v
                    last[i] = t
                    strength[a] -= strength[a] >> 5
                    ddx = cx - NEST_X
                    ddy = cy - NEST_Y
                    if ddx * ddx + ddy * ddy <= NEST_RADIUS_SQ:
                        returning[a] = 0
                        strength[a] = 0
                        h = (h + 8) & 15

            ah[a] = h
            ax[a] = x
            ay[a] = y

        if t % SCORE_EVERY == 0 or t == ticks:
            scores = [acc + v for acc, v in zip(scores, trail_at(t))]

    win_src = 0
    for s in range(1, n):
        if scores[s] > scores[win_src]:
            win_src = s
    win_opt = perm.index(win_src)

    buf = bytearray(VERSION + seed + struct.pack(">B", n) + stake_hash + odds_hash)
    for s in range(n):
        buf += struct.pack(">BBH", sx[s], sy[s], rich[s])
    for s in range(n):
        buf += struct.pack(">I", scores[s])
    buf += struct.pack(">B", win_src) + bytes(perm)
    return {
        "winner_source": win_src,
        "winner_option": win_opt,
        "scores": scores,
        "perm": perm,
        "sources": list(zip(sx, sy, rich)),
        "hash": hashlib.sha256(bytes(buf)).hexdigest(),
    }


def burn_run(seed, weights, stake_hash, ants=N_ANTS, ticks=TICKS):
    """Burn colony: five menu options, richness from the Burn colony's stakes."""
    return run(seed, 5, stake_richness(weights), ants, ticks, stake_hash=stake_hash)


def forecast_run(seed, kind, odds, odds_6h, weights=None, stake_hash=None, ants=N_ANTS, ticks=TICKS):
    """One forecaster on one market. Community reads `weights` (that market's
    stakes); the others read the odds snapshot."""
    if kind == COMMUNITY:
        assert weights is not None and len(weights) == len(odds)
        rich = stake_richness(weights)
    else:
        rich = odds_richness(kind, odds, odds_6h)
    return run(seed, len(odds), rich, ants, ticks, stake_hash=stake_hash, odds_hash=odds_snapshot_hash(odds, odds_6h))


def market_colony(m):
    """Colony id (and staking colony id) of market m in the round."""
    assert 0 <= m < 0xFFFF
    return 1 + m


def colony_seed(round_seed, colony, slot=0):
    """Seed for one colony's map: the round seed, the colony id and the
    forecaster slot (the kind; 0 for the Burn colony)."""
    assert len(round_seed) == 32 and 0 <= colony <= 0xFFFF and 0 <= slot <= 255
    return hashlib.sha256(COLONY_TAG + round_seed + struct.pack(">HB", colony, slot)).digest()


def trail_shares(result):
    """Per-option trail share in basis points, summing to exactly 10000.

    Each share is floored; the remainder goes to the winning option. With no
    trail at all every option gets an even share (remainder to the winner).
    """
    scores = [result["scores"][s] for s in result["perm"]]
    n, total = len(scores), sum(scores)
    shares = [x * BPS // total for x in scores] if total else [BPS // n] * n
    shares[result["winner_option"]] += BPS - sum(shares)
    return shares


def market_result(colony, runs):
    """Combine the four forecaster runs (in KINDS order) of one market.

    Swarm belief per option is the floored mean of the four trail shares; the
    remainder goes to the option with the largest sum (lowest index on ties).
    Market hash = sha256(tag, colony u16, n u8, four colony hashes, swarm u16 each).
    """
    assert len(runs) == len(KINDS)
    shares = [trail_shares(r) for r in runs]
    n = len(shares[0])
    sums = [sum(s[o] for s in shares) for o in range(n)]
    swarm = [x // len(KINDS) for x in sums]
    top = 0
    for o in range(1, n):
        if sums[o] > sums[top]:
            top = o
    swarm[top] += BPS - sum(swarm)
    buf = MARKET_TAG + struct.pack(">HB", colony, n)
    buf += b"".join(bytes.fromhex(r["hash"]) for r in runs) + struct.pack(">%dH" % n, *swarm)
    return {
        "colony": colony,
        "colonies": [dict(r, shares=sh) for r, sh in zip(runs, shares)],
        "swarm": swarm,
        "hash": hashlib.sha256(buf).hexdigest(),
    }


def forecast_market(round_seed, colony, odds, odds_6h, weights, stake_hash,
                    ants=FORECAST_ANTS, ticks=FORECAST_TICKS):
    """The four forecasters on one market, each on its own map.

    colony: the market's colony id (`market_colony(m)`). weights: that
    colony's stake weights, one per outcome (zeros when nobody staked).
    """
    runs = [
        forecast_run(colony_seed(round_seed, colony, k), k, odds, odds_6h, weights, stake_hash, ants, ticks)
        for k in KINDS
    ]
    return market_result(colony, runs)


def seed_from_int(i):
    return hashlib.sha256(b"seed-%d" % i).digest()


if __name__ == "__main__":
    import sys
    import time

    k = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    t0 = time.time()
    out = run(seed_from_int(k))
    print(json.dumps(out), "%.2fs" % (time.time() - t0))
