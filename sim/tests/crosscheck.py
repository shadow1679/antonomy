"""Check that the Python reference, the JS port and the Rust port produce identical hashes.

Usage: python3 -I sim/tests/crosscheck.py [count] [--no-py] [--day]   (default 50 seeds)
Each seed runs seven colonies: 5 outcomes, 2 outcomes, 3 outcomes with fixed
richness, a Burn colony with stakes, and the three forecasters (Momentum,
Community, Agents) on one market. The last four use 60 ants
and 300 ticks. Two more keys are whole forecast markets (three forecasters on
their own maps, trail shares, swarm belief): a 3-outcome market with stakes and
agent posts, and a binary market with neither. Python needs about 1.5 s per seed, so use
--no-py to compare only JS against Rust on large counts (the 10,000-seed gate).
Rust is skipped with a warning if cargo isn't found.

--day checks the Burn colony's daily run instead (150 ants, BURN_TICKS =
43,200 ticks, key hd). Rust takes about 0.1 s per seed, JS about 1 s and
Python about half a minute, so keep the count small.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))
import antosim  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith("--")]
use_py = "--no-py" not in sys.argv
day = "--day" in sys.argv
count = int(args[0]) if args else (3 if day else 50)
KEYS = ("hd",) if day else ("h5", "h2", "h3", "hb", "hm", "hk", "ha", "hs", "hy")
mode = ["day"] if day else []

# Fixtures shared with dump.mjs and dump.rs.
STAKE_HASH = hashlib.sha256(b"stakes").digest()
BURN_WEIGHTS = [0, 40000, 9000, 0, 2500]
ODDS, ODDS_6H = [6200, 2800, 1000], [5500, 3300, 1200]
MARKET_WEIGHTS = [3000, 0, 12000]
BINARY_ODDS = [9000, 1000]
AGENT_ODDS = [4500, 4000, 1500]
AGENT_HASH = hashlib.sha256(b"agents").digest()


def lines(cmd):
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.splitlines()
    rows = [json.loads(line) for line in out]
    assert len(rows) == count, (cmd, len(rows), count)
    return rows


def find_cargo():
    return shutil.which("cargo") or next(
        (p for p in [os.path.expanduser("~/.cargo/bin/cargo")] if os.access(p, os.X_OK)), None
    )


impls = {"js": lines(["node", os.path.join(HERE, "dump.mjs"), "0", str(count)] + mode)}

cargo = find_cargo()
if cargo:
    manifest = os.path.join(HERE, "..", "rust", "Cargo.toml")
    env = dict(os.environ, PATH=os.path.dirname(cargo) + os.pathsep + os.environ.get("PATH", ""))
    subprocess.run([cargo, "build", "--release", "--quiet", "--manifest-path", manifest], check=True, env=env)
    exe = os.path.join(HERE, "..", "rust", "target", "release", "dump")
    impls["rust"] = lines([exe, "0", str(count)] + mode)
else:
    print("WARNING: cargo not found, skipping Rust")

if use_py and day:
    impls["py"] = [
        {"i": row["i"], "hd": antosim.burn_run(
            antosim.seed_from_int(row["i"]), BURN_WEIGHTS, STAKE_HASH, antosim.N_ANTS, antosim.BURN_TICKS)["hash"]}
        for row in impls["js"]
    ]
elif use_py:
    py_rows = []
    for row in impls["js"]:
        seed = antosim.seed_from_int(row["i"])
        py_rows.append({
            "i": row["i"],
            "h5": antosim.run(seed, 5)["hash"],
            "h2": antosim.run(seed, 2)["hash"],
            "h3": antosim.run(seed, 3, [300, 250, 200])["hash"],
            "hb": antosim.burn_run(seed, BURN_WEIGHTS, STAKE_HASH, 60, 300)["hash"],
            **{
                key: antosim.forecast_run(
                    seed, kind, ODDS, ODDS_6H, MARKET_WEIGHTS, STAKE_HASH, AGENT_ODDS, AGENT_HASH, 60, 300
                )["hash"]
                for key, kind in (
                    ("hm", antosim.MOMENTUM), ("hk", antosim.COMMUNITY), ("ha", antosim.AGENTS),
                )
            },
            "hs": antosim.forecast_market(
                seed, antosim.market_colony(0), ODDS, ODDS_6H, MARKET_WEIGHTS, STAKE_HASH,
                AGENT_ODDS, AGENT_HASH)["hash"],
            "hy": antosim.forecast_market(
                seed, antosim.market_colony(1), BINARY_ODDS, BINARY_ODDS, [0, 0], antosim.ZERO32,
                [0, 0], antosim.ZERO32)["hash"],
        })
    impls["py"] = py_rows

# The first implementation is the baseline; every other one must match it.
names = list(impls)
if len(names) < 2:
    print("need at least two implementations to compare")
    sys.exit(1)
base = names[0]
bad = 0
for other in names[1:]:
    for a, b in zip(impls[base], impls[other]):
        assert a["i"] == b["i"]
        for k in KEYS:
            if a[k] != b[k]:
                bad += 1
                print("MISMATCH seed", a["i"], k, base, a[k], other, b[k])

print("%d seeds x %d %s, %s: %s" % (
    count, len(KEYS), "daily Burn colony run" if day else "colonies", " = ".join(names), "ALL MATCH" if bad == 0 else "%d mismatches" % bad))
sys.exit(1 if bad else 0)
