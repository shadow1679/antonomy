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

// Request #0 on antonomy-oracle.testnet (worlds-2026-winner, one keeper, one
// agent). Its inputs, seed and payouts are from the live contract; the colony
// hashes, swarm, market hash and crank rows were recomputed for three
// colonies (the testnet contract ran five until it was redeployed).
export const REQUEST_0 = {
  "id": 0,
  "colony": 32768,
  "requester": "requester.antonomy-oracle.testnet",
  "market_id": "worlds-2026-winner",
  "fee": "100000000000000000000000000",
  "phase": "done",
  "created_at_ms": 1793095654722,
  "odds_by_ms": 1793096254722,
  "forecast_by_ms": 1793095830072,
  "keepers_posted": [],
  "market": {
    "colony": 32768,
    "market_id": "worlds-2026-winner",
    "outcomes": [
      "Gen.G",
      "T1",
      "Dplus KIA",
      "Bilibili Gaming",
      "Other"
    ],
    "odds": [
      4350,
      1550,
      1205,
      1150,
      1745
    ],
    "odds_6h": [
      4350,
      1550,
      1095,
      1150,
      1855
    ],
    "odds_hash": "8bfef0c590c502552ed03f49fc9f5f25affc78f9a113970eb07c0922e96a4cb9",
    "raw_hashes": [
      [
        "keeper.antonomy-oracle.testnet",
        "e0c740fd2885c0767ed2d2ad9b63f28cf17ccf188bf214a1117f8fcd4bd69460"
      ]
    ]
  },
  "agents": {
    "odds": [
      4000,
      2000,
      1200,
      1200,
      1600
    ],
    "hash": "7826c3058bca43daae432e7c4b3d5498b1be249e0dadc3cc155bbf86b7f62e6d",
    "posts": [
      [
        "agent.antonomy-oracle.testnet",
        [
          4000,
          2000,
          1200,
          1200,
          1600
        ]
      ]
    ]
  },
  "seed": "2c6896734b408ba1cb0c0b8ff446b088085c1189afcda29ed3d1c6e05c4aaafb",
  "colony_hashes": [
    "72aa20d788ddaeb9632f99d50a3cbe42aaac341196d176eff35a0b88b4019c5b",
    "0d6966e007d9248b95a88384e1b0dbb9b2c166206e73da1e4ea8b0ef64428bd3",
    "ebf761afa0ec53f82d23d2ab8cf504184369fc93e1de90602ba0dfa2079afcbc"
  ],
  "crankers": [
    "cranker.antonomy-oracle.testnet",
    "cranker.antonomy-oracle.testnet",
    "cranker.antonomy-oracle.testnet"
  ],
  "swarm": [
    3409,
    1457,
    2690,
    1702,
    742
  ],
  "market_hash": "ae6c24108df6b4ed00d9e8b47dbd842ddf7e57fe7bd55822260968301c2cc987",
  "paid_keepers": [
    [
      "keeper.antonomy-oracle.testnet",
      "20000000000000000000000000"
    ]
  ],
  "paid_agents": [
    [
      "agent.antonomy-oracle.testnet",
      "30000000000000000000000000"
    ]
  ],
  "paid_cranks": [
    [
      "cranker.antonomy-oracle.testnet",
      "3333333333333333333333333"
    ],
    [
      "cranker.antonomy-oracle.testnet",
      "3333333333333333333333333"
    ],
    [
      "cranker.antonomy-oracle.testnet",
      "3333333333333333333333333"
    ]
  ],
  "to_treasury": "40000000000000000000000001"
};
