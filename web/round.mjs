// Where the pages get a round's colonies. There is no contract yet, so the
// live round comes from a demo clock: every viewer derives the same round
// number from the wall clock, and the round seed is sha256("seed-<round>").
// Stakes and odds are fixtures. Once the contract runs rounds, replace
// demoRound() with a read of the current round (seed, stake and odds
// snapshots, each colony's tick) and keep the shape it returns.

import {
  Colony, seedFromInt, colonySeed, marketColony, stakeRichness, oddsRichness, oddsSnapshotHash,
  BURN_COLONY, KINDS, COMMUNITY, N_ANTS, TICKS, FORECAST_ANTS, FORECAST_TICKS,
} from "../sim/js/antosim.mjs";

export const GLYPHS = ["▲", "■", "◆", "●", "★"];
export const BURN_MENU = ["0.10%", "0.25%", "0.50%", "1.00%", "2.00%"];
export const KIND_NAMES = ["Follower", "Contrarian", "Momentum", "Community"];
export const KIND_BLURB = [
  "Trusts the market: richer food where the odds are higher.",
  "Thinks the crowd is overconfident: underdogs are richer.",
  "Follows the six-hour move in the odds.",
  "Follows holder stakes on this market.",
];

export const ROUND_MS = 150_000; // one demo round
export const RUN_MS = 120_000;   // the colonies run for this long, then the result shows

const ZERO32 = new Uint8Array(32);

// Fixture snapshots. The market is the one sim/tests/crosscheck.py uses.
// Stake weights are milli sqrt-tokens per option, as Staking::sim_weights gives them.
const BURN_WEIGHTS = [0, 4000, 9000, 2000, 0];
const MARKETS = [
  {
    title: "Fed decision at the next meeting",
    outcomes: ["Cut", "Hold", "Hike"],
    odds: [6200, 2800, 1000],
    odds6h: [5500, 3300, 1200],
    weights: [3000, 0, 12000],
  },
];

// Every colony of a round, Burn first, then each market's four forecasters
// in KINDS order. make() returns a fresh Colony at tick 0.
export function roundColonies(roundSeed) {
  const burnSeed = colonySeed(roundSeed, BURN_COLONY);
  const burn = {
    key: "burn",
    seed: burnSeed,
    colony: BURN_COLONY,
    name: "Burn colony",
    labels: BURN_MENU,
    ants: N_ANTS,
    ticks: TICKS,
    make: () => new Colony(burnSeed, 5, stakeRichness(BURN_WEIGHTS), N_ANTS, TICKS, ZERO32),
  };
  const markets = MARKETS.map((m, i) => {
    const colony = marketColony(i);
    const oddsHash = oddsSnapshotHash(m.odds, m.odds6h);
    const forecasters = KINDS.map((k) => {
      const rich = k === COMMUNITY ? stakeRichness(m.weights) : oddsRichness(k, m.odds, m.odds6h);
      const seed = colonySeed(roundSeed, colony, k);
      return {
        key: `m${i}-${KIND_NAMES[k].toLowerCase()}`,
        seed,
        colony,
        kind: k,
        name: KIND_NAMES[k],
        market: m.title,
        labels: m.outcomes,
        ants: FORECAST_ANTS,
        ticks: FORECAST_TICKS,
        make: () => new Colony(seed, m.outcomes.length, rich,
          FORECAST_ANTS, FORECAST_TICKS, ZERO32, oddsHash),
      };
    });
    return { ...m, index: i, colony, forecasters };
  });
  return { burn, markets, all: [burn, ...markets.flatMap((m) => m.forecasters)] };
}

export function demoRound(now = Date.now()) {
  const id = Math.floor(now / ROUND_MS);
  const startMs = id * ROUND_MS;
  const seed = seedFromInt(id);
  return {
    id,
    seed,
    startMs,
    runEndMs: startMs + RUN_MS,
    nextMs: startMs + ROUND_MS,
    ...roundColonies(seed),
  };
}

// 0 to 1: how far through its ticks every colony of the round should be at `now`.
export const roundProgress = (round, now = Date.now()) =>
  Math.min(1, Math.max(0, (now - round.startMs) / (round.runEndMs - round.startMs)));

export function roundById(id) {
  const seed = seedFromInt(id);
  return { id, seed, ...roundColonies(seed) };
}
