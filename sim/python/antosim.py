"""Antonomy reference simulation (integer only), spec v0.

This is the reference every other implementation (JS replay, Rust contract)
must match bit for bit. No floats anywhere in the simulation: positions are
Q8 fixed point, headings are 16 discrete directions from a lookup table, and
the PRNG is xoshiro128** on 32-bit words.

Not yet implemented (see docs/HACKATHON_ROADMAP.md): map templates (walls,
river), stake snapshot input, per-colony personality parameters.
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
CAP = 20 * 256              # pheromone cap per cell, Q8
DECAY_Q16 = 65536 - 524     # per-tick retention, ~0.8% evaporation
SENSE_DIST = 3              # cells ahead that a searching ant samples
WANDER = 64                 # out of 256: chance per step of a random turn
DEPOSIT_BASE = 512          # deposit strength at pickup, Q8, times richness
FOOD_RADIUS_SQ = 4          # cells^2
NEST_RADIUS_SQ = 4          # cells^2
SCORE_RADIUS_SQ = 36        # cells^2 (6 cells)
RICH_MIN, RICH_SPAN = 179, 155   # richness Q8: 0.7 .. 1.3
DIST_MIN, DIST_SPAN = 9, 13      # food distance from nest in cells: 9 .. 21
MARGIN = 4                  # food is clamped at least this far from the edge
VERSION = b"ANTO-SIM-v0"

M32 = 0xFFFFFFFF

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tables.json")) as _f:
    _T = json.load(_f)
COS64, SIN64 = _T["cos64"], _T["sin64"]
DX = [COS64[k * 4] for k in range(16)]
DY = [SIN64[k * 4] for k in range(16)]

# Lazy evaporation: DECAY_T[n] = retention factor (Q16) after n ticks.
DECAY_T = [65536]
for _n in range(TICKS + 1):
    DECAY_T.append((DECAY_T[-1] * DECAY_Q16) >> 16)


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


def run(seed, n=5, richness=None, ants=N_ANTS, ticks=TICKS):
    """Run one colony.

    seed: 32 bytes. n: number of outcomes (2..5). richness: optional list of n
    Q8 ints that replaces the seed-derived richness (forecast colonies).
    Returns a dict with the winning option, scores and the result hash.
    """
    assert len(seed) == 32 and 2 <= n <= 5
    assert richness is None or len(richness) == n
    rng = Rng(seed)

    # Food placement. Draws are always made so the stream stays aligned.
    sx, sy = [], []
    for i in range(n):
        idx = ((i * 64) // n + rng.next() % 8 - 4) & 63
        dist = DIST_MIN + rng.next() % DIST_SPAN
        fx = NEST_X + ((COS64[idx] * dist) >> 8)
        fy = NEST_Y + ((SIN64[idx] * dist) >> 8)
        sx.append(min(max(fx, MARGIN), W - 1 - MARGIN))
        sy.append(min(max(fy, MARGIN), H - 1 - MARGIN))
    rich = []
    for i in range(n):
        drawn = RICH_MIN + rng.next() % RICH_SPAN
        rich.append(drawn if richness is None else richness[i])

    # Seeded shuffle: perm[option] = food source index.
    perm = list(range(n))
    for i in range(n - 1, 0, -1):
        j = rng.next() % (i + 1)
        perm[i], perm[j] = perm[j], perm[i]

    val = [0] * (W * H)
    last = [0] * (W * H)
    ax = [NEST_X * 256 + 128] * ants
    ay = [NEST_Y * 256 + 128] * ants
    ah = [rng.next() & 15 for _ in range(ants)]
    returning = [0] * ants
    strength = [0] * ants
    nest_tx, nest_ty = NEST_X * 256 + 128, NEST_Y * 256 + 128

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
                        v = (val[i] * DECAY_T[t - last[i]]) >> 16
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
                    v = ((val[i] * DECAY_T[t - last[i]]) >> 16) + strength[a]
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

    # Scoring: pheromone within 6 cells of each source at the final tick.
    scores = []
    for s in range(n):
        total = 0
        for yy in range(sy[s] - 6, sy[s] + 7):
            for xx in range(sx[s] - 6, sx[s] + 7):
                ddx = xx - sx[s]
                ddy = yy - sy[s]
                if ddx * ddx + ddy * ddy <= SCORE_RADIUS_SQ and 0 <= xx < W and 0 <= yy < H:
                    i = yy * W + xx
                    total += (val[i] * DECAY_T[ticks - last[i]]) >> 16
        scores.append(total)

    win_src = 0
    for s in range(1, n):
        if scores[s] > scores[win_src]:
            win_src = s
    win_opt = perm.index(win_src)

    buf = bytearray(VERSION + seed + struct.pack(">B", n))
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


def seed_from_int(i):
    return hashlib.sha256(b"seed-%d" % i).digest()


if __name__ == "__main__":
    import sys
    import time

    k = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    t0 = time.time()
    out = run(seed_from_int(k))
    print(json.dumps(out), "%.2fs" % (time.time() - t0))
