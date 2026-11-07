// Burn history: every burn day from the demo genesis up to a given day, run in
// order so each day burns from what the day before left in the treasury. Pure
// data and no DOM, so Node can test it. The amount is the contract's:
// floor(treasury × bps / 10000) in base units (24 decimals), as burn_amount in
// token/src/burn.rs. There is no contract yet, so the genesis day and the
// starting treasury are fixtures; once burns run on testnet, read the rows
// from the contract's burn events instead and keep the shape.

import { trailShares, toHex, run, seedFromInt } from "../sim/js/antosim.mjs";
import { burnDay, DAY_MS } from "./round.mjs";

export const ONE = 10n ** 24n;
export const BURN_MENU_BPS = [10, 25, 50, 100, 200]; // token/src/burn.rs
export const GENESIS_DAY = Date.UTC(2026, 9, 19) / DAY_MS; // first demo burn day, 19 Oct 2026
export const TREASURY_START = 100_000_000n * ONE;          // demo treasury on the genesis day

export function burnAmount(treasury, index) {
  const bps = BURN_MENU_BPS[index];
  if (bps === undefined) throw new RangeError("bad burn index");
  return (treasury * BigInt(bps)) / 10_000n;
}

// Whole tokens with thousands separators (rounded down).
export const fmtTokens = (base) => (base / ONE).toLocaleString("en");

// A day's run is 43,200 ticks (about 1 s of sim), so it runs in chunks with
// `yieldTo` between them and the page keeps painting.
const CHUNK = 2000;
async function finish(col, yieldTo) {
  while (col.t < col.ticks) {
    for (let i = 0; i < CHUNK && col.step(); i++);
    if (yieldTo) await yieldTo();
  }
  return col.result();
}

// A past day never changes, so each one runs once: results are kept in
// memory and, in a browser, in localStorage (keyed by the sim's fingerprint
// and the day seed). Replay re-runs any day from its seed to check a stored row.
const runs = new Map(); // day -> { winner_option, scores, perm, hash }
const store = typeof window === "undefined" ? null : window.localStorage;
// The hash of a tiny run past a score checkpoint: it changes whenever the sim's
// algorithm does, version bump or not, so stale rows are never read back.
const SIM_PRINT = run(seedFromInt(0), 5, null, 10, 150).hash.slice(0, 16);
const storeKey = (d) => `antonomy:burn:${SIM_PRINT}:${d.burn.ticks}:${toHex(d.seed)}`;
const keep = ({ winner_option, scores, perm, hash }) => ({ winner_option, scores, perm, hash });

function stored(d) {
  try { return JSON.parse(store?.getItem(storeKey(d)) ?? "null"); } catch { return null; }
}

// One row per finished day in [GENESIS_DAY, toDay), oldest first, plus the
// treasury left for day `toDay` and the total burned. `yieldTo` (optional,
// async) runs between chunks of a day's run so a page can paint;
// `onDay(i, n)` reports progress before day i of n runs.
export async function burnHistory(toDay, { yieldTo, onDay } = {}) {
  const rows = [];
  let treasury = TREASURY_START;
  for (let day = GENESIS_DAY; day < toDay; day++) {
    const d = burnDay(day);
    if (!runs.has(day)) {
      let r = stored(d);
      if (!r) {
        onDay?.(day - GENESIS_DAY, toDay - GENESIS_DAY);
        r = keep(await finish(d.burn.make(), yieldTo));
        try { store?.setItem(storeKey(d), JSON.stringify(r)); } catch { /* storage full or blocked */ }
      }
      runs.set(day, r);
    }
    const result = runs.get(day);
    const index = result.winner_option;
    const burned = burnAmount(treasury, index);
    rows.push({
      day, date: d.date, seed: toHex(d.seed), index, bps: BURN_MENU_BPS[index],
      shares: trailShares(result), hash: result.hash,
      before: treasury, burned, after: treasury - burned,
    });
    treasury -= burned;
  }
  return { rows, treasury, burned: TREASURY_START - treasury };
}
