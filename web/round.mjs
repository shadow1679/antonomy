// Shared colony builders. The round itself (markets, odds, stakes, seed,
// hashes) is read from the contract by roundchain.mjs, which feeds
// marketForecasters() below with the on-chain inputs. The Burn half of this
// file is the Burn page's.
//
// The Burn colony runs on its own daily clock, one run per UTC day in two
// halves. 00:00 to 12:00 UTC: staking is open and sugar piles up. 12:00:
// stakes close and the first crank_burn draws the day seed on chain.
// 12:00 to 24:00: BURN_TICKS (43,200) ticks, one a second, and the burn
// executes after the final tick. Sugar dropped after 12:00 counts for
// tomorrow's colony.

import { DAY_MS, STAKING_MS, hexToBytes, snapshotWeights, snapshotWallets, burnRichnessFor } from "./burn.mjs";
import {
  Colony, sha256, colonySeed, stakeRichness, oddsRichness, oddsSnapshotHash,
  agentRichness, voters, BURN_COLONY, KINDS, COMMUNITY, AGENTS, N_ANTS, BURN_TICKS, FORECAST_ANTS, FORECAST_TICKS,
} from "../sim/js/antosim.mjs";
import { walletWeights, stakerAnts, agentAnts } from "./ds/staker-ants.mjs";

export const GLYPHS = ["▲", "■", "◆", "●", "★"];
export const BURN_MENU = ["0.10%", "0.25%", "0.50%", "1.00%", "2.00%"];
export const KIND_NAMES = ["Momentum", "Community", "Agents"];
// One line per tile; the Docs page has the long version.
export const KIND_BLURB = [
  "Follows the 6-hour move.",
  "Follows $ANTO stakes.",
  "Follows AI agents' odds.",
];

// How long a page takes to play a colony's 300 ticks on screen. Only
// recruit.html still imports it; nothing on the round pages uses it.
export const RUN_MS = 120_000;

const ZERO32 = new Uint8Array(32);

// ---- The Burn colony ----
// A day's seed is drawn on chain by the first crank_burn after 12:00 UTC, and
// its stakes are the snapshot frozen at 12:00. The contract keeps only the
// newest run and forgets a day's snapshot once it is burned, so this browser
// remembers the days it has seen (seed, stake hash, snapshot entries, and the
// result once verified) in memory and in localStorage. burnchain.mjs fills
// the memory from the contract (rememberBurnDay); replay re-runs from it.
export { DAY_MS, STAKING_MS };

const KNOWN_KEY = "antonomy:burn-days:v1";
const KEEP_DAYS = 60;
const known = new Map(); // day -> { day, seed, stakeHash, entries, winner?, hash? } (hex strings; entries as the contract returns them)
const store = () => (typeof window === "undefined" ? null : window.localStorage);
try {
  for (const k of JSON.parse(store()?.getItem(KNOWN_KEY) ?? "[]")) known.set(k.day, k);
} catch { /* no storage, or a stale value */ }

// Keep what the chain returned for `day`. Merges, so a later call can add the
// verified result to what an earlier one stored.
export function rememberBurnDay(info) {
  const old = known.get(info.day) ?? {};
  const next = { ...old, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined && v !== null)) };
  known.set(info.day, next);
  const days = [...known.keys()].sort((a, b) => a - b);
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) known.delete(d);
  try { store()?.setItem(KNOWN_KEY, JSON.stringify([...known.values()])); } catch { /* storage full or blocked */ }
  return next;
}
export const knownBurnDay = (day) => known.get(day) ?? null;
export const knownBurnDays = () => [...known.keys()].sort((a, b) => a - b);

// The Burn colony for one day seed (32 bytes, or null while it isn't known to
// this browser) with the stake inputs the chain committed to: `weights` (milli
// sqrt-tokens per option), `stakeHash` (32 bytes) and `wallets` (for the staker
// ants, which are cosmetic). make() returns a fresh Colony at tick 0 and is
// what must reproduce the contract's result hash.
export function burnColony(daySeed, { day = Infinity, weights = new Array(5).fill(0), stakeHash = ZERO32, wallets = [] } = {}) {
  const seed = daySeed ? colonySeed(daySeed, BURN_COLONY) : null;
  return {
    key: "burn",
    seed,
    colony: BURN_COLONY,
    name: "Burn colony",
    labels: BURN_MENU,
    ants: N_ANTS,
    ticks: BURN_TICKS,
    weights,
    stakeHash,
    stakers: stakerAnts(wallets, N_ANTS),
    make: () => {
      if (!seed) throw new Error("This day's seed isn't known to this browser yet: open the Burn page while the day runs, or after the first crank_burn.");
      return new Colony(seed, 5, burnRichnessFor(day, weights), N_ANTS, BURN_TICKS, stakeHash);
    },
  };
}

// Burn day `day` (days since 1970-01-01 UTC): its clock and, if this browser
// has the chain's inputs for it, its seed and colony. `known` says whether it
// does; when it doesn't, seed is null and burn.make() throws. Staking runs from
// startMs to runMs, the colony from runMs to endMs. For a day that was never
// seen, `await ensureBurnDay(day)` from burnchain.mjs tries the chain first.
export function burnDay(day) {
  const startMs = day * DAY_MS, runMs = startMs + STAKING_MS, endMs = startMs + DAY_MS;
  const k0 = known.get(day);
  const k = k0?.seed && k0.stakeHash && k0.entries ? k0 : null; // a partial record is not enough to re-run
  const seed = k ? hexToBytes(k.seed) : null;
  return {
    day, seed, known: !!k, startMs, runMs, endMs,
    date: new Date(startMs).toISOString().slice(0, 10),
    stakeHash: k?.stakeHash ?? null,
    winner: k?.winner ?? null,   // the chain's pick, once this browser has seen the finished run
    hash: k?.hash ?? null,       // the chain's result hash, likewise
    burn: burnColony(seed, k ? {
      day, weights: snapshotWeights(k.entries), stakeHash: hexToBytes(k.stakeHash), wallets: snapshotWallets(k.entries),
    } : undefined),
  };
}

export const currentBurnDay = (now = Date.now()) => burnDay(Math.floor(now / DAY_MS));
export const demoBurnDay = currentBurnDay; // old name; delete once nothing imports it

// The newest day whose seed can be drawn: today from 12:00 UTC, else yesterday.
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

// Old name: there is no per-wallet list while staking
// is open (the contract's views give per-option totals only), so this is empty.
// The day's wallets come from the frozen snapshot (burnchain.mjs). Delete once
// nothing imports it.
export const stakesAt = () => [];

// One market's five forecasters in KINDS order, as specs whose make()
// returns a fresh Colony at tick 0. `m` has outcomes, odds, odds6h, weights,
// stakeHash (optional, zeros by default), wallets and agentOdds (an
// agentSnapshot: odds, hash and, for agent ants, posts). Requested markets
// reuse this with their own colony id.
export function marketForecasters(roundSeed, colony, m, keyPrefix) {
  const oddsHash = oddsSnapshotHash(m.odds, m.odds6h);
  const stakeHash = m.stakeHash ?? ZERO32;
  // A colony with no input (no stakes, no agent posts) runs but abstains.
  const counted = voters(m.weights, m.agentOdds.odds);
  return KINDS.map((k) => {
    const rich = k === COMMUNITY ? stakeRichness(m.weights)
      : k === AGENTS ? agentRichness(m.agentOdds.odds)
      : oddsRichness(k, m.odds, m.odds6h);
    // Agents commits the agent-odds snapshot in place of the market odds.
    const commit = k === AGENTS ? m.agentOdds.hash : oddsHash;
    const seed = colonySeed(roundSeed, colony, k);
    return {
      key: `${keyPrefix}-${KIND_NAMES[k].toLowerCase()}`,
      seed,
      colony,
      kind: k,
      name: KIND_NAMES[k],
      market: m.title,
      labels: m.outcomes,
      ants: FORECAST_ANTS,
      ticks: FORECAST_TICKS,
      counted: counted[k],
      // Only Community reads stakes, so only it has staker ants; Agents has
      // agent ants when the agents' posts are known (agentOdds.posts).
      stakers: k === COMMUNITY && m.wallets.length ? stakerAnts(m.wallets, FORECAST_ANTS)
        : k === AGENTS && m.agentOdds.posts?.length ? agentAnts(m.agentOdds.posts, FORECAST_ANTS) : null,
      make: () => new Colony(seed, m.outcomes.length, rich,
        FORECAST_ANTS, FORECAST_TICKS, stakeHash, commit),
    };
  });
}

// The round's markets are read from the contract: see loadRound() in
// roundchain.mjs. The Burn colony isn't part of a round; see burnDay().
