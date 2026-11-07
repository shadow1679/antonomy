"""Check that the Python reference, the JS port and the Rust port produce identical hashes.

Usage: python3 -I sim/tests/crosscheck.py [count] [--no-py]   (default 50 seeds)
Each seed runs three colonies: 5 outcomes, 2 outcomes, and 3 outcomes with
fixed (forecast-style) richness. Python needs about 1.5 s per seed, so use
--no-py to compare only JS against Rust on large counts (the 10,000-seed gate).
Rust is skipped with a warning if cargo isn't found.
"""
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
count = int(args[0]) if args else 50
KEYS = ("h5", "h2", "h3")


def lines(cmd):
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.splitlines()
    rows = [json.loads(line) for line in out]
    assert len(rows) == count, (cmd, len(rows), count)
    return rows


def find_cargo():
    return shutil.which("cargo") or next(
        (p for p in [os.path.expanduser("~/.cargo/bin/cargo")] if os.access(p, os.X_OK)), None
    )


impls = {"js": lines(["node", os.path.join(HERE, "dump.mjs"), "0", str(count)])}

cargo = find_cargo()
if cargo:
    manifest = os.path.join(HERE, "..", "rust", "Cargo.toml")
    env = dict(os.environ, PATH=os.path.dirname(cargo) + os.pathsep + os.environ.get("PATH", ""))
    subprocess.run([cargo, "build", "--release", "--quiet", "--manifest-path", manifest], check=True, env=env)
    exe = os.path.join(HERE, "..", "rust", "target", "release", "dump")
    impls["rust"] = lines([exe, "0", str(count)])
else:
    print("WARNING: cargo not found, skipping Rust")

if use_py:
    py_rows = []
    for row in impls["js"]:
        seed = antosim.seed_from_int(row["i"])
        py_rows.append({
            "i": row["i"],
            "h5": antosim.run(seed, 5)["hash"],
            "h2": antosim.run(seed, 2)["hash"],
            "h3": antosim.run(seed, 3, [3000, 1200, 500])["hash"],
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

print("%d seeds x 3 colonies, %s: %s" % (
    count, " = ".join(names), "ALL MATCH" if bad == 0 else "%d mismatches" % bad))
sys.exit(1 if bad else 0)
