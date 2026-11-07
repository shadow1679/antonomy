// Test-only: canned contract JSON (round_status, last_round) whose hashes are
// computed with the sim, so offline tests can exercise the pages' chain code.
import { forecastMarket, sha256, toHex, oddsSnapshotHash } from "../sim/js/antosim.mjs";
import { agentSnapshot } from "./agents.mjs";

const hx = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

// One crosscheck-style market; `salt` changes the seed so two rounds differ.
export function cannedRound(id, { cranked = 3, salt = String(id) } = {}) {
  const seedHex = toHex(sha256(new TextEncoder().encode(`canned-seed-${salt}`)));
  const stakeHash = toHex(sha256(new TextEncoder().encode(`canned-stakes-${salt}`)));
  const mv = {
    colony: 1, market_id: "fed-decision-in-october-20260617190323537", outcomes: ["Cut", "Hold", "Hike"],
    odds: [6200, 2800, 1000], odds_6h: [5500, 3300, 1200], raw_hashes: [["keeper.antonomy-oracle.testnet", "ab".repeat(32)]],
  };
  mv.odds_hash = toHex(oddsSnapshotHash(mv.odds, mv.odds_6h));
  const weights = [3000, 0, 12000];
  const posts = [{ id: "llm.testnet", odds: [5500, 3500, 1000] }, { id: "base.testnet", odds: [6500, 3000, 500] }];
  const sn = agentSnapshot(posts, 3);
  const agents = { odds: sn.odds, hash: toHex(sn.hash), posts: posts.map((p) => [p.id, p.odds]) };
  const t = forecastMarket(hx(seedHex), 1, mv.odds, mv.odds_6h, weights, hx(stakeHash), agents.odds, sn.hash);
  const run = {
    round: id, seed: seedHex, stake_hash: stakeHash, done: cranked === 3,
    markets: [{ colony: 1, weights, agents, colony_hashes: t.colonies.map((c) => c.hash).slice(0, cranked),
      crankers: ["c.testnet", "d.testnet", "c.testnet"].slice(0, cranked),
      swarm: cranked === 3 ? t.swarm : null, market_hash: cranked === 3 ? t.hash : null }],
  };
  return { mv, run, truth: t };
}
