// Usage: node dump.mjs <first_seed> <count> [day]
// With "day", prints only hd: the Burn colony's daily run (150 ants, BURN_TICKS).
// Prints one JSON line per seed: the result hashes for n=5, n=2, a run with
// fixed richness, a Burn colony with stakes and the five forecasters on one
// market (60 ants, 300 ticks), plus two whole forecast markets (hs with agent
// posts, hy without).
// crosscheck.py compares these with Python.
import {
  run, seedFromInt, sha256, burnRun, forecastRun,
  MOMENTUM, COMMUNITY, AGENTS, forecastMarket, marketColony, N_ANTS, BURN_TICKS,
} from "../js/antosim.mjs";

// Fixtures shared with crosscheck.py and sim/rust/src/bin/dump.rs.
const STAKE_HASH = sha256(new TextEncoder().encode("stakes"));
const BURN_WEIGHTS = [0, 40000, 9000, 0, 2500];
const ODDS = [6200, 2800, 1000], ODDS_6H = [5500, 3300, 1200];
const MARKET_WEIGHTS = [3000, 0, 12000];
const BINARY_ODDS = [9000, 1000];
const AGENT_ODDS = [4500, 4000, 1500];
const AGENT_HASH = sha256(new TextEncoder().encode("agents"));
const small = (kind) => forecastRun(seed, kind, ODDS, ODDS_6H, MARKET_WEIGHTS, STAKE_HASH, AGENT_ODDS, AGENT_HASH, 60, 300).hash;
let seed;

const first = parseInt(process.argv[2], 10);
const count = parseInt(process.argv[3], 10);
const day = process.argv[4] === "day";
for (let i = first; i < first + count; i++) {
  seed = seedFromInt(i);
  if (day) {
    console.log(JSON.stringify({ i, hd: burnRun(seed, BURN_WEIGHTS, STAKE_HASH, N_ANTS, BURN_TICKS).hash }));
    continue;
  }
  const a = run(seed, 5);
  const b = run(seed, 2);
  const c = run(seed, 3, [300, 250, 200]);
  console.log(JSON.stringify({
    i, h5: a.hash, h2: b.hash, h3: c.hash, w5: a.winner_option,
    hb: burnRun(seed, BURN_WEIGHTS, STAKE_HASH, 60, 300).hash,
    hm: small(MOMENTUM), hk: small(COMMUNITY), ha: small(AGENTS),
    hs: forecastMarket(seed, marketColony(0), ODDS, ODDS_6H, MARKET_WEIGHTS, STAKE_HASH, AGENT_ODDS, AGENT_HASH).hash,
    hy: forecastMarket(seed, marketColony(1), BINARY_ODDS, BINARY_ODDS, [0, 0], new Uint8Array(32), [0, 0], new Uint8Array(32)).hash,
  }));
}
