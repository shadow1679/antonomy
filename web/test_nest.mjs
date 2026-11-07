// Offline tests for the nest page's pure parts: node web/test_nest.mjs
import assert from "node:assert/strict";
import { ONE } from "./chain.mjs";
import { buildRound } from "./roundchain.mjs";
import { recordedMarket, RECORDED } from "./landing.mjs";
import {
  CHAMBERS, LAYOUTS, FLOWS, AMBIENT, GALLERY_CELLS, layoutFor, nestScale, smoothPath, pathOf, pointAt,
  pileLevel, flameLevel, guardCounts, nurseryEggs, queenEggs, galleryCells, deriveNest, diffEvents, logLine, chainLog, who, nestSummary,
} from "./nest.mjs";

const T = (n) => (BigInt(n) * ONE).toString(); // whole $ANTO -> base units

// Layouts: every chamber in both, inside the frame, and every tunnel starts
// and ends at the rim of the chambers its flow joins.
for (const [name, L] of Object.entries(LAYOUTS)) {
  for (const c of CHAMBERS) {
    const h = L.chambers[c.id];
    assert.ok(h, `${name} has ${c.id}`);
    assert.ok(h.x - h.rx >= 0 && h.x + h.rx <= L.w && h.y + h.ry <= L.h, `${name} ${c.id} fits`);
  }
  for (const [flow, f] of Object.entries(FLOWS)) {
    const pts = L.flows[flow];
    assert.ok(pts?.length >= 2, `${name} ${flow} has a tunnel`);
    const at = (p, id) => { const h = L.chambers[id]; return Math.hypot((p[0] - h.x) / h.rx, (p[1] - h.y) / h.ry); };
    assert.ok(Math.abs(at(pts[0], f.from) - 1) < 0.3, `${name} ${flow} leaves ${f.from}`);
    assert.ok(Math.abs(at(pts.at(-1), f.to) - 1) < 0.3, `${name} ${flow} reaches ${f.to}`);
    assert.ok(Number.isInteger(AMBIENT[flow]));
  }
  // Chambers don't overlap.
  const ids = CHAMBERS.map((c) => c.id);
  for (const a of ids) for (const b of ids) {
    if (a >= b) continue;
    const p = L.chambers[a], q = L.chambers[b];
    const apart = Math.abs(p.x - q.x) >= p.rx + q.rx || Math.abs(p.y - q.y) >= p.ry + q.ry;
    assert.ok(apart, `${name}: ${a} and ${b} overlap`);
  }
}
assert.equal(layoutFor(1200), "wide");
assert.equal(layoutFor(390), "tall");
assert.equal(nestScale(1440, "wide"), 12);
assert.equal(nestScale(200, "wide"), 4);    // never below 4 px a unit
assert.equal(nestScale(9999, "wide"), 16);  // nor above 16

// Paths: smoothing passes through the ends; walking is by arc length.
{
  const sm = smoothPath([[0, 0], [10, 0], [10, 10]]);
  assert.deepEqual(sm[0], [0, 0]);
  assert.deepEqual(sm.at(-1), [10, 10]);
  const p = pathOf([[0, 0], [10, 0]]);
  assert.ok(Math.abs(p.len - 10) < 1e-9);
  const mid = pointAt(p, 5);
  assert.ok(Math.abs(mid.x - 5) < 1e-9 && mid.y === 0 && mid.ang === 0);
  assert.deepEqual([pointAt(p, -3).x, pointAt(p, 99).x], [0, 10]); // clamped
  const down = pointAt(pathOf([[0, 0], [0, 4]]), 2);
  assert.ok(Math.abs(down.ang - Math.PI / 2) < 1e-9);
}

// Piles and the flame.
assert.equal(pileLevel(null, T(10)), 0);
assert.equal(pileLevel(T(0), T(10)), 0);
assert.equal(pileLevel(T(25), T(100)), 0.5);       // square root of a quarter
assert.equal(pileLevel(T(1), T(1_000_000)), 0.08); // tiny piles still show
assert.equal(pileLevel(T(200), T(100)), 1);
assert.equal(flameLevel(0), 0.35);
assert.equal(flameLevel(4), 1);
assert.equal(flameLevel(undefined), 0.45);

// The guard, the nursery and the queen's eggs.
const REQS = [
  { id: 0, phase: "done", market_id: "a" },
  { id: 1, phase: "skipped", market_id: "b" },
  { id: 2, phase: "odds", market_id: "c", agents: null },
  { id: 3, phase: "forecasting", market_id: "d", agents: { posts: [["x.testnet", [5000, 5000]], ["y.testnet", [6000, 4000]]] } },
  { id: 4, phase: "running", market_id: "e" },
];
assert.deepEqual(guardCounts(REQS), { queued: 1, accepted: 3, turnedAway: 1 });
assert.deepEqual(guardCounts(null), { queued: 0, accepted: 0, turnedAway: 0 });
{
  const n = nurseryEggs(REQS, 4);
  assert.equal(n.blue, 2);       // requests 2 and 3 wait to run
  assert.equal(n.pink, 2 + 4);   // two posts on request 3, four on the round
}

// A round shaped as loadRound() gives it: round 5 posting, round 4 (the
// recording) finished before it.
const rec = recordedMarket();
const lastRound = {
  markets: [{ colony: RECORDED.mv.colony, market_id: RECORDED.mv.market_id, outcomes: RECORDED.mv.outcomes, odds: RECORDED.mv.odds, odds_6h: RECORDED.mv.odds_6h, odds_hash: rec.oddsHash, raw_hashes: [] }],
  run: {
    round: 4, seed: RECORDED.run.seed, stake_hash: RECORDED.run.stakeHash,
    markets: [{ colony: RECORDED.mv.colony, weights: RECORDED.run.weights, agents: RECORDED.run.agents, colony_hashes: RECORDED.run.colonyHashes, crankers: [], swarm: RECORDED.run.swarm, market_hash: RECORDED.run.marketHash }],
  },
};
const status = { round: 5, phase: "posting", close_at_ms: 0, publish_at_ms: 0, drand_round: 33543347, markets: null, run: null };
const round = buildRound(status, lastRound);
{
  const eggs = queenEggs(round);
  assert.deepEqual(eggs.map((e) => e.round), [1, 2, 3, 4, 5]);
  assert.equal(eggs.at(-1).state, "laying");
  assert.deepEqual(eggs[3].hashes, [RECORDED.run.marketHash]);
  assert.equal(queenEggs(buildRound({ ...status, round: 30 }, null)).length, 8); // at most 8 drawn
  assert.deepEqual(queenEggs(null), []);
}

// The gallery: twelve cells, the shown round's markets first. Round 4's
// swarm favoured No (56.2%) as did the market (81.5%): no glow.
{
  const cells = galleryCells(round.shown);
  assert.equal(cells.length, GALLERY_CELLS);
  assert.equal(cells.filter(Boolean).length, 1);
  assert.deepEqual([cells[0].marketLead, cells[0].swarmLead, cells[0].differs], [1, 1, false]);
  assert.equal(galleryCells({ markets: [{ ...rec, odds: [9000, 1000] }] })[0].differs, true);
  const unrun = galleryCells({ markets: [{ ...rec, swarm: null }] })[0];
  assert.deepEqual([unrun.swarmLead, unrun.differs], [null, false]);
}

// The chambers' numbers from a full read, and with every read failed.
const READS = {
  token: { supply: BigInt(T(987_500)), treasury: BigInt(T(800_000)), faucet: BigInt(T(150)), genesis: BigInt(T(1_000_000)), burned: BigInt(T(12_500)), me: null },
  escrow: BigInt(T(3_000)),
  vaults: { stakes: BigInt(T(2_500)), fees: BigInt(T(400)), deposits: BigInt(T(100)) },
  round, requests: REQS, agentPosts: 4,
  rcfg: { fee: T(100), keeper_bps: 3000, agent_bps: 3000, crank_bps: 3000, agent_deposit: T(10) },
  stakeCfg: { cap_per_wallet: T(100) },
  keepers: [["keeper.antonomy-oracle.testnet", "keeper2.antonomy-oracle.testnet", "keeper3.antonomy-oracle.testnet"], 2],
  agents: ["agent.antonomy-oracle.testnet"],
  paused: false,
  pot: [{ burn: T(160), reward: T(640) }, { burn: T(14_720), reward: T(1_280) }],
  schedule: { phase: "staking" },
  randomness: { count: 3, latest: { id: 2, status: "ready", drand_round: 33500000 } },
  lastBurn: { day: 20756, index: 2, burned: BigInt(T(3_040)) },
};
{
  const m = deriveNest(READS);
  for (const c of CHAMBERS) assert.ok(m[c.id]?.headline, `${c.id} has a headline`);
  assert.equal(m.entrance.headline, "150 $ANTO free");
  assert.equal(m.guard.headline, "3 in · 1 turned away");
  assert.ok(m.guard.rows.some(([k, v]) => k === "Keepers' quorum" && v === "2 of 3"));
  assert.ok(m.guard.rows.some(([k, v]) => k === "Stake cap" && v === "100 $ANTO per wallet"));
  assert.equal(m.nursery.headline, "2 requests · 6 agent posts");
  assert.equal(m.queen.headline, "Round 5 · staking");
  assert.equal(m.granary.headline, "800K $ANTO in the treasury");
  assert.equal(m.granary.treasuryLevel, Math.sqrt(0.8));
  assert.ok(m.granary.rows.some(([k, v]) => k === "Held for others" && v === "3,000 $ANTO"));
  assert.ok(m.granary.rows.some(([k, v]) => k === "Request fees in escrow" && v === "400 $ANTO"));
  assert.equal(m.burn.headline, "12.5K $ANTO burned");
  assert.ok(m.burn.rows.some(([k, v]) => k === "Last burn" && v === "day 20756: 3,040 $ANTO, pot 0.50%"));
  assert.ok(m.burn.rows.some(([k, v]) => k === "Today's pot" && v === "800 $ANTO to 16K $ANTO"));
  assert.equal(m.burn.flame, flameLevel(2));
  assert.equal(m.gallery.headline, "1 market · the swarm differs on 0");
  assert.equal(m.gallery.from, "Previous round 4");
  assert.equal(m.well.headline, "drand #33543347");
  assert.equal(m.workers.headline, "3 keepers · 1 agent");
  assert.ok(m.workers.rows.some(([k, v]) => k === "Fee split" && v === "keepers 30% · agents 30% · crankers 30%"));
  assert.ok(nestSummary(m).startsWith("Entrance: 150 $ANTO free. Guard post: 3 in · 1 turned away."));
  // Every amount the panels show is labelled $ANTO.
  for (const c of CHAMBERS) for (const [k, v] of m[c.id].rows) {
    if (/\d,\d{3}|\dK\b/.test(v) && !/drand|day \d+$|^Request/.test(`${k} ${v}`)) assert.match(v, /\$ANTO|USDC/, `${c.id}: ${v}`);
  }
}
{
  const m = deriveNest({});
  for (const c of CHAMBERS) assert.equal(typeof m[c.id].headline, "string");
  assert.equal(m.guard.headline, "—");
  assert.equal(m.gallery.headline, "No markets yet");
  assert.equal(m.granary.treasuryLevel, 0);
  assert.equal(m.guard.paused, false);
}

// What changed between two reads: ants to send.
{
  const a = READS;
  const b = {
    ...READS,
    escrow: BigInt(T(3_050)),
    token: { ...READS.token, supply: BigInt(T(987_000)) },
    requests: [...REQS.map((q) => (q.id === 2 ? { ...q, phase: "skipped" } : q.id === 3 ? { ...q, phase: "done" } : q)), { id: 5, phase: "odds", market_id: "f" }],
    randomness: { count: 4, latest: null },
  };
  const ev = diffEvents(a, b);
  assert.deepEqual(ev.map((e) => e.flow), ["stake", "burn", "reject", "hatch", "submit", "seed"]);
  assert.equal(ev[0].text, "50 $ANTO came into the granary (a stake or a fee)");
  assert.equal(ev[1].text, "500 $ANTO burned");
  assert.deepEqual(diffEvents(null, b), []);
  assert.deepEqual(diffEvents(a, a), []);
  const next = buildRound({ ...status, round: 6 }, lastRound);
  assert.deepEqual(diffEvents({ round }, { round: next }).map((e) => e.flow), ["result"]);
}

// The nest log: indexer transactions as plain lines.
{
  const tx = (method, from, ms = 1_793_000_000_000, ok = true) => ({
    transaction_hash: `h-${method}`, predecessor_account_id: from, receiver_account_id: "antonomy-oracle.testnet",
    block_timestamp: String(BigInt(ms) * 1_000_000n), actions: [{ method }], outcomes: { status: ok },
  });
  assert.deepEqual(logLine(tx("crank_round", "cranker.antonomy-oracle.testnet")),
    { ms: 1_793_000_000_000, chamber: "queen", text: "cranker cranked a forecast colony", tx: "h-crank_round", method: "crank_round" });
  assert.equal(logLine(tx("post_trending", "keeper2.antonomy-oracle.testnet")).text, "keeper2 posted the trending markets' odds");
  assert.equal(logLine(tx("execute_burn", "alice.testnet")).chamber, "burn");
  assert.equal(logLine(tx("crank_round", "x.testnet", 0, false)), null); // failed calls are left out
  assert.equal(logLine(tx("new", "antonomy-oracle.testnet")), null);    // and calls it doesn't describe
  assert.equal(who("antonomy-oracle.testnet"), "the contract");
  assert.equal(who(null), "someone");
  assert.equal(who("a-very-long-implicit-account-0123456789abcdef"), "a-very-lon…6789abcdef");
}

// The chain-dated log, for when the indexer lists nothing.
{
  const lines = chainLog({
    requests: [{ id: 7, requester: "requester.antonomy-oracle.testnet", market_id: "fed-decision-in-december", phase: "skipped", created_at_ms: 1_793_000_000_000 }, { id: 8, phase: "odds" }],
    randomness: { count: 2, latest: { id: 1, requester: "bob.testnet", status: "ready", requested_at_ms: 1_793_000_100_000 } },
  });
  assert.deepEqual(lines, [
    { key: "req-7", ms: 1_793_000_000_000, chamber: "guard", text: "requester asked the swarm about fed-decision-in-december (request #7: turned away, fee refunded)" },
    { key: "rnd-1", ms: 1_793_000_100_000, chamber: "well", text: "bob.testnet requested random value #1 (ready)" },
  ]);
  assert.deepEqual(chainLog(null), []);
}

console.log("nest: ok");
