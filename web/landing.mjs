// The landing page's pure parts (docs/LANDING_PAGE.md): round 4's recorded
// market, which the hero replays before the chain answers (or when it can't),
// the hero's pace, how scrolling through How the ants forecast maps to a
// tick, the map's size in whole pixels per cell, and the text summary that
// stands in for the map under reduced motion. No DOM; test_landing.mjs runs
// it in Node.

import { W, H, SCORE_EVERY, oddsSnapshotHash, toHex } from "../sim/js/antosim.mjs";
import { buildMarket } from "./roundchain.mjs";

// The hero plays at the player's 1× speed: 300 ticks in 25 s.
export const HERO_TPS = 12;

// Round 4's market on antonomy-oracle.testnet, as the contract held it
// (`last_round`, read 2026-10-29; the same inputs as docs/example_market.mjs).
// The chain's market hash commits all three colony hashes and the swarm
// belief, so the colony hashes here, recomputed from these inputs, are the
// ones the chain had: test_landing.mjs re-checks the market hash.
export const RECORDED = {
  round: 4,
  mv: {
    colony: 4,
    market_id: "what-price-will-bitcoin-hit-in-october-2026",
    outcomes: ["Yes", "No"],
    odds: [1850, 8150],
    odds_6h: [850, 9150],
  },
  run: {
    seed: "046eaa516b1971b2da7080c166690ad1add23dfa6dd34e1e445f1c597269b237",
    stakeHash: "e2ac4dc21e0b3b41e8425a524705b2fc9d5cc722a30f512bff5813142d63bf2e",
    weights: [1732, 0],
    agents: { odds: [1850, 8150], hash: "aebafe80945405dd8db37ee22e1c8474fd203c041da68dc448d9b51dd34ba68d", posts: [] },
    colonyHashes: [
      "1eb2f368352adb637f4deef9b2bcbd135cc72e4c91f5c9cb772a8394a415e1c2",
      "3e985790615c458109c61072dc6e6ba840553826a253122ac23f09e839b32228",
      "b218accf7a161b0a0b1c56539bb37c8f0bbba871b0ee05ea2cac70581ff3de0f",
    ],
    swarm: [4377, 5623],
    marketHash: "cb34d8d2a1d10b2699ffdc5af8e1f5da245810ede0b8281d683fce3c316d9c3e",
  },
};

// Round 4's market in the shape loadRound() gives every market.
export function recordedMarket() {
  const { mv, run } = RECORDED;
  return buildMarket({ ...mv, odds_hash: toHex(oddsSnapshotHash(mv.odds, mv.odds_6h)), raw_hashes: [] }, run, { index: 0, tag: "rec" });
}

// Scroll through the four How steps -> tick, for a run of `ticks` ticks.
// p runs 0..1 over the steps, a quarter each: the seed (tick 0), foraging up
// to the first checkpoint, then every checkpoint held for a moment with the
// stretches between them, and the check (the last tick).
export function storyTick(p, ticks) {
  const x = Math.min(1, Math.max(0, p)) * 4;
  const step = Math.min(3, Math.floor(x)), q = x - step;
  const first = Math.min(SCORE_EVERY, ticks);
  if (step === 0) return 0;
  if (step === 1) return Math.round(q * first);
  if (step === 3) return ticks;
  // Step 2: holds at each checkpoint, ramps between them.
  const cps = [];
  for (let c = first; c < ticks; c += SCORE_EVERY) cps.push(c);
  cps.push(ticks);
  const parts = cps.length * 2 - 1, at = q * parts, i = Math.min(parts - 1, Math.floor(at)), f = at - i;
  return i % 2 === 0 ? cps[i / 2] : Math.round(cps[(i - 1) / 2] + f * (cps[(i + 1) / 2] - cps[(i - 1) / 2]));
}

// With scrolling off (and under reduced motion) each step shows one still.
export const stepTick = (step, ticks) => [0, Math.min(SCORE_EVERY, ticks), ticks, ticks][step] ?? ticks;

// Pixels per cell for the hero map: the largest whole number that fits.
// Wide (two columns): at most 70% of the viewport, leaving the copy column
// 400px, and the full map under the top bar with 96px to spare. Narrow (one
// column): the viewport's width, at most 720px, and half its height.
export function heroCell({ vw, vh, top = 56, pad = 24, gap = 48, wide = vw >= 1000 }) {
  const byW = wide ? Math.min(0.7 * vw, vw - 2 * pad - gap - 400) : Math.min(vw, 720);
  const byH = wide ? vh - top - 96 : vh / 2;
  return Math.max(3, Math.min(20, Math.floor(byW / W), Math.floor(byH / H)));
}

// One sentence a screen reader (and a reduced-motion reader) gets in place of
// the map. shares: this colony's trail share per outcome in %; swarm: the
// swarm belief in basis points or null; check: "match" | "mismatch" | null.
export function summaryText({ where, name, t, ticks, outcomes, shares, swarm, check }) {
  const list = (vals) => outcomes.map((o, i) => `${o} ${vals[i].toFixed(1)}%`).join(", ");
  let s = `${where}, ${name} colony, tick ${t} of ${ticks}.`;
  if (shares && shares.some((x) => x > 0)) s += ` Trail share: ${list(shares)}.`;
  else s += " No trail yet.";
  if (swarm) s += ` Swarm belief across the colonies: ${list(swarm.map((b) => b / 100))}.`;
  if (check === "match") s += " The hash your browser computed matches the chain.";
  else if (check === "mismatch") s += " The hash your browser computed differs from the chain's.";
  return s;
}
