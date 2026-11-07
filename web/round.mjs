// Where the pages get a round's colonies. There is no contract yet, so the
// live round comes from a demo clock: every viewer derives the same round
// number from the wall clock, and the round seed is sha256("seed-<round>").
// Stakes and odds are fixtures. Once the contract runs rounds, replace
// demoRound() with a read of the current round (seed, stake and odds
// snapshots, each colony's tick) and keep the shape it returns.
//
// The Burn colony runs on its own daily clock, one run per UTC day in two
// halves. 00:00 to 12:00 UTC: staking is open and sugar piles up. 12:00:
// stakes close and the day seed is drawn. 12:00 to 24:00: BURN_TICKS
// (43,200) ticks play live, one a second, and the burn executes at the final
// tick. Sugar dropped after 12:00 counts for tomorrow's colony. The demo day
// seed is sha256("burn-day-<day>"); demoBurnDay() is the seam for the
// contract's current burn day.

import {
  Colony, sha256, seedFromInt, colonySeed, marketColony, stakeRichness, oddsRichness, oddsSnapshotHash,
  BURN_COLONY, KINDS, COMMUNITY, N_ANTS, BURN_TICKS, FORECAST_ANTS, FORECAST_TICKS,
} from "../sim/js/antosim.mjs";
import { walletWeights, stakerAnts } from "./ds/staker-ants.mjs";

export const GLYPHS = ["▲", "■", "◆", "●", "★"];
export const BURN_MENU = ["0.10%", "0.25%", "0.50%", "1.00%", "2.00%"];
export const KIND_NAMES = ["Follower", "Contrarian", "Momentum", "Community"];
// One line per tile; the Docs page has the long version.
export const KIND_BLURB = [
  "Backs the favourite.",
  "Backs the underdog.",
  "Follows the 6-hour move.",
  "Follows $ANTO stakes.",
];

export const ROUND_MS = 150_000; // one demo round
export const RUN_MS = 120_000;   // the colonies run for this long, then the result shows

const ZERO32 = new Uint8Array(32);

// Fixture snapshots. The market is the one sim/tests/crosscheck.py uses.
// Stakes are fixture wallets (whole tokens per option). The weights the sim
// reads are derived from them the way Staking::sim_weights does (milli
// sqrt-tokens per option), so the staker ants and the food richness agree.
// `at` is when the wallet stakes, in minutes after 00:00 UTC, so the demo's
// sugar piles up through the staking half of the day.
export const BURN_WALLETS = [
  { id: "alice.testnet", stakes: [0, 4, 0, 0, 0], at: 40 },
  { id: "bob.testnet", stakes: [0, 4, 0, 0, 0], at: 155 },
  { id: "carol.testnet", stakes: [0, 0, 9, 0, 0], at: 230 },
  { id: "dave.testnet", stakes: [0, 0, 9, 0, 0], at: 380 },
  { id: "erin.testnet", stakes: [0, 0, 9, 0, 0], at: 515 },
  { id: "frank.testnet", stakes: [0, 0, 0, 4, 0], at: 655 },
];
const BURN_WEIGHTS = walletWeights(BURN_WALLETS, 5); // [0, 4000, 9000, 2000, 0]
// Six fixture markets so the Live page shows a board of forecasts; how many
// markets a round can afford on chain is still open (gas). Market 0 is the
// one crosscheck.py uses, so keep it first and unchanged.
const MARKETS = [
  {
    title: "Fed decision at the next meeting",
    topic: "Macro",
    outcomes: ["Cut", "Hold", "Hike"],
    odds: [6200, 2800, 1000],
    odds6h: [5500, 3300, 1200],
    wallets: [
      { id: "grace.testnet", stakes: [9, 0, 0] },
      { id: "heidi.testnet", stakes: [0, 0, 16] },
      { id: "ivan.testnet", stakes: [0, 0, 16] },
      { id: "judy.testnet", stakes: [0, 0, 16] },
    ],
  },
  {
    title: "Bitcoin above $150k on 31 December",
    topic: "Crypto",
    outcomes: ["Yes", "No"],
    odds: [2300, 7700],
    odds6h: [2600, 7400],
    wallets: [
      { id: "kim.testnet", stakes: [25, 0] },
      { id: "leo.testnet", stakes: [0, 9] },
      { id: "mia.testnet", stakes: [4, 0] },
    ],
  },
  {
    title: "US inflation for November, year on year",
    topic: "Macro",
    outcomes: ["2.5% or less", "2.6% to 2.9%", "3.0% or more"],
    odds: [1800, 5900, 2300],
    odds6h: [2000, 5600, 2400],
    wallets: [
      { id: "nina.testnet", stakes: [0, 16, 0] },
      { id: "omar.testnet", stakes: [0, 0, 9] },
    ],
  },
  {
    title: "NEAR price on 30 November",
    topic: "Crypto",
    outcomes: ["Under $2", "$2 to $4", "$4 to $6", "Over $6"],
    odds: [1500, 5200, 2400, 900],
    odds6h: [1200, 5000, 2800, 1000],
    wallets: [
      { id: "pia.testnet", stakes: [0, 0, 16, 0] },
      { id: "quinn.testnet", stakes: [0, 0, 9, 0] },
      { id: "rosa.testnet", stakes: [0, 0, 0, 25] },
      { id: "sam.testnet", stakes: [0, 4, 0, 0] },
    ],
  },
  {
    title: "Champions League 2026–27 winner",
    topic: "Sport",
    outcomes: ["Real Madrid", "Man City", "Bayern", "Arsenal", "Other"],
    odds: [1900, 1600, 1400, 1300, 3800],
    odds6h: [2000, 1700, 1300, 1100, 3900],
    wallets: [
      { id: "tom.testnet", stakes: [0, 0, 0, 16, 0] },
      { id: "uma.testnet", stakes: [9, 0, 0, 0, 0] },
      { id: "vic.testnet", stakes: [0, 0, 4, 0, 0] },
    ],
  },
  {
    title: "Next Ethereum upgrade live before 1 March",
    topic: "Crypto",
    outcomes: ["Yes", "No"],
    odds: [4100, 5900],
    odds6h: [3500, 6500],
    wallets: [
      { id: "wes.testnet", stakes: [0, 16] },
      { id: "xia.testnet", stakes: [0, 16] },
    ],
  },
].map((m) => ({ ...m, weights: walletWeights(m.wallets, m.outcomes.length) })); // [3000, 0, 12000]

// The Burn colony for one day seed. make() returns a fresh Colony at tick 0.
export function burnColony(daySeed) {
  const seed = colonySeed(daySeed, BURN_COLONY);
  return {
    key: "burn",
    seed,
    colony: BURN_COLONY,
    name: "Burn colony",
    labels: BURN_MENU,
    ants: N_ANTS,
    ticks: BURN_TICKS,
    stakers: stakerAnts(BURN_WALLETS, N_ANTS),
    make: () => new Colony(seed, 5, stakeRichness(BURN_WEIGHTS), N_ANTS, BURN_TICKS, ZERO32),
  };
}

export const DAY_MS = 86_400_000;
export const STAKING_MS = DAY_MS - BURN_TICKS * 1000; // 00:00 to 12:00 UTC
const enc = new TextEncoder();
export const daySeed = (day) => sha256(enc.encode(`burn-day-${day}`));

// Burn day `day` (days since 1970-01-01 UTC): its seed, its clock and its
// colony. Staking runs from startMs to runMs, the colony from runMs to endMs.
export function burnDay(day) {
  const seed = daySeed(day);
  const startMs = day * DAY_MS, runMs = startMs + STAKING_MS, endMs = startMs + DAY_MS;
  return {
    day, seed, startMs, runMs, endMs,
    date: new Date(startMs).toISOString().slice(0, 10),
    burn: burnColony(seed),
  };
}

export const demoBurnDay = (now = Date.now()) => burnDay(Math.floor(now / DAY_MS));

// The newest day whose seed is drawn: today from 12:00 UTC, else yesterday.
// Pages must not show a seed, a map or a result before then.
export const drawnBurnDay = (now = Date.now()) => burnDay(Math.floor((now - STAKING_MS) / DAY_MS));

// "staking" before 12:00 UTC, "running" until 24:00.
export const dayPhase = (d, now = Date.now()) => (now < d.runMs ? "staking" : "running");

// 0 to 1: how far through its ticks the run is at `now` (0 while staking).
// Times runProgress by the colony's ticks for the tick (one a second).
export const runProgress = (d, now = Date.now()) =>
  Math.min(1, Math.max(0, (now - d.runMs) / (d.endMs - d.runMs)));

// 0 to 1: how far through the UTC day `now` is, for the day card.
export const dayProgress = (d, now = Date.now()) =>
  Math.min(1, Math.max(0, (now - d.startMs) / DAY_MS));

// The wallets that have staked on day `d` by `now`: all of them once staking
// has closed. Stakes are a fixture, so this is the demo's stand-in for the
// contract's stake_totals view while staking is open.
export const stakesAt = (d, now = Date.now()) =>
  BURN_WALLETS.filter((w) => d.startMs + w.at * 60_000 <= now);

// Each market's four forecasters in KINDS order. make() returns a fresh
// Colony at tick 0. The Burn colony isn't part of a round; see burnDay().
export function roundColonies(roundSeed) {
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
        // Only Community reads stakes, so only it has staker ants.
        stakers: k === COMMUNITY ? stakerAnts(m.wallets, FORECAST_ANTS) : null,
        make: () => new Colony(seed, m.outcomes.length, rich,
          FORECAST_ANTS, FORECAST_TICKS, ZERO32, oddsHash),
      };
    });
    return { ...m, index: i, colony, forecasters };
  });
  return { markets, all: markets.flatMap((m) => m.forecasters) };
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
