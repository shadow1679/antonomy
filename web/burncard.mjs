// Today's burn, read from the contract, for the small card on the Live page.
// (The Burn page has the full view.) Before 12:00 UTC there is no seed, so the
// card only has staking totals; from 12:00 the contract's run exists and the
// browser re-runs the Burn colony from the on-chain day seed and stake
// snapshot, up to the tick the chain says it has reached. Pure data, no DOM.

import { Colony, colonySeed, BURN_COLONY, N_ANTS, BURN_TICKS } from "../sim/js/antosim.mjs";
import { burnRichnessFor } from "./burn.mjs";
import { view, hexToBytes } from "./chain.mjs";

// Integer square root of a non-negative BigInt.
export function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

const SIM_WEIGHT_DIV = 1_000_000_000n;

// Staking::burn_weights: per option, the sum of isqrt(stake) over the Burn
// colony's entries, in milli sqrt-tokens. Entries are [account, colony, option, amount_yocto].
export function burnWeights(entries, n = 5) {
  const w = new Array(n).fill(0n);
  for (const [, colony, option, amount] of entries) {
    if (colony === BURN_COLONY && option < n) w[option] += isqrt(BigInt(amount));
  }
  return w.map((x) => Number(x / SIM_WEIGHT_DIV));
}

// The Burn colony as the contract builds it: map seed colony_seed(day seed,
// BURN_COLONY, 0), five options, richness from the stake weights.
export function burnColonyFor(run, weights) {
  const seed = colonySeed(hexToBytes(run.seed), BURN_COLONY, 0);
  return new Colony(seed, 5, burnRichnessFor(run.day, weights), N_ANTS, BURN_TICKS, hexToBytes(run.stake_hash));
}

// state: "staking" (before 12:00 UTC, no seed), "waiting" (past 12:00 but
// nobody has started the day's run), "running" or "done".
export async function loadBurnCard({ call = view, now = Date.now() } = {}) {
  const [sched, run] = await Promise.all([call("burn_schedule"), call("burn_run")]);
  const today = run && run.day === sched.day ? run : null;
  const out = { sched, run: today, last: run && !today ? run : null, polledAt: now, totals: null, weights: null, snapshotOk: null };
  if (today) {
    out.state = today.done ? "done" : "running";
    try {
      const snap = await call("burn_snapshot", { day: today.day });
      out.entries = snap.entries;
      out.weights = burnWeights(snap.entries);
      out.snapshotOk = snap.hash === today.stake_hash;
    } catch { /* the snapshot is gone once a day is burned; scores come with the result */ }
    return out;
  }
  out.state = sched.phase === "running" ? "waiting" : "staking";
  try {
    const totals = await call("stake_totals", { colony: BURN_COLONY, n_options: 5 });
    out.totals = totals.map((x) => BigInt(x));
  } catch { /* leave unknown */ }
  return out;
}
