// Usage: node dump.mjs <first_seed> <count>
// Prints one JSON line per seed: the result hashes for n=5, n=2 and a
// forecast-style run with fixed richness. crosscheck.py compares these with Python.
import { run, seedFromInt } from "../js/antosim.mjs";

const first = parseInt(process.argv[2], 10);
const count = parseInt(process.argv[3], 10);
for (let i = first; i < first + count; i++) {
  const seed = seedFromInt(i);
  const a = run(seed, 5);
  const b = run(seed, 2);
  const c = run(seed, 3, [3000, 1200, 500]);
  console.log(JSON.stringify({ i, h5: a.hash, h2: b.hash, h3: c.hash, w5: a.winner_option }));
}
