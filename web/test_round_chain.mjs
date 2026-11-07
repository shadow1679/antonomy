// Offline tests for the round adapter: node web/test_round_chain.mjs
// The contract is stubbed with canned JSON in the shape its views return. The
// "chain" hashes are computed with the same sim code, so these tests cover the
// adapter (shapes, phases, previous round, verification), not a live chain.
import assert from "node:assert/strict";
import { forecastMarket, sha256, toHex, marketColony } from "../sim/js/antosim.mjs";
import { agentSnapshot } from "./agents.mjs";
import { slugTitle, buildRound, loadRound, verifyMarket, verifyRound, walletsFor } from "./roundchain.mjs";

const ONE = 10n ** 24n;
const seedHex = toHex(sha256(new TextEncoder().encode("test-round-seed")));
const stakeHash = toHex(sha256(new TextEncoder().encode("test-stake-hash")));
const SLUG = "fed-decision-in-october-20260617190323537";

// The crosscheck market, as a keeper would post it.
const mv = {
  colony: 1, market_id: SLUG, outcomes: ["Cut", "Hold", "Hike"],
  odds: [6200, 2800, 1000], odds_6h: [5500, 3300, 1200],
  odds_hash: "", raw_hashes: [["keeper.antonomy-oracle.testnet", "ab".repeat(32)]],
};
{ // the odds hash the contract stores is sha256 over the snapshot; take it from the sim
  const { oddsSnapshotHash } = await import("../sim/js/antosim.mjs");
  mv.odds_hash = toHex(oddsSnapshotHash(mv.odds, mv.odds_6h));
}

// Weights (milli sqrt-tokens) and agent posts for the Community and Agents colonies.
const weights = [3000, 0, 12000];
const posts = [
  { id: "llm-macro.testnet", odds: [5500, 3500, 1000] },
  { id: "base-rates.testnet", odds: [6500, 3000, 500] },
];
const snap = agentSnapshot(posts, 3);
const agents = { odds: snap.odds, hash: toHex(snap.hash), posts: posts.map((p) => [p.id, p.odds]) };

const seed = Uint8Array.from(seedHex.match(/../g), (h) => parseInt(h, 16));
const stakeBytes = Uint8Array.from(stakeHash.match(/../g), (h) => parseInt(h, 16));
const truth = forecastMarket(seed, 1, mv.odds, mv.odds_6h, weights, stakeBytes, agents.odds, snap.hash);
const hashes = truth.colonies.map((c) => c.hash);

const run = (n) => ({
  round: 4, seed: seedHex, stake_hash: stakeHash, done: n === 3,
  markets: [{
    colony: 1, weights, agents, colony_hashes: hashes.slice(0, n), crankers: ["c.testnet", "d.testnet", "c.testnet"].slice(0, n),
    swarm: n === 3 ? truth.swarm : null, market_hash: n === 3 ? truth.hash : null,
  }],
});
const status = (phase, extra = {}) => ({ round: 4, phase, close_at_ms: 1_000, publish_at_ms: 2_000, markets: [mv], run: null, ...extra });

// ---- titles from the event slug
assert.equal(slugTitle(SLUG), "Fed decision in October");
assert.equal(slugTitle("will-btc-hit-150k-by-december-31"), "Will BTC hit 150k by December 31");
assert.equal(slugTitle("mlb-mil-tb-2026-10-27"), "MLB MIL TB, 27 Oct 2026");
assert.equal(slugTitle("wta-rakhimo-alexand-2026-10-27"), "WTA Rakhimo Alexand, 27 Oct 2026");
assert.equal(slugTitle("france-declares-state-of-emergency-byptptpt"), "France declares state of emergency");
assert.equal(slugTitle("balance-of-power-2026-midterms"), "Balance of power 2026 midterms");
assert.equal(slugTitle("606422"), "Polymarket event 606422");
assert.equal(slugTitle("20260617190323537"), "Polymarket event 20260617190323537");

// ---- posting: the market and its odds, no seed, no colonies
{
  const r = buildRound(status("posting"), null, { totals: [["1000000000000000000000000", "0", "0"]] });
  assert.equal(r.phase, "posting");
  assert.equal(r.hasRun, false);
  assert.equal(r.markets.length, 1);
  const m = r.markets[0];
  assert.equal(m.title, "Fed decision in October");
  assert.equal(m.marketId, SLUG);
  assert.equal(m.oddsHashOk, true);
  assert.equal(m.forecasters, null, "no maps before the seed exists");
  assert.equal(r.seed, null);
  assert.deepEqual(m.stakes, ["1000000000000000000000000", "0", "0"]);
  assert.equal(r.all.length, 0);
  assert.equal(r.shown, r, "nothing earlier to show");
  assert.deepEqual(m.rawHashes[0][1], "ab".repeat(32));
}

// ---- no market yet
{
  const r = buildRound({ round: 0, phase: "posting", close_at_ms: 1, publish_at_ms: 2, markets: null, run: null }, null);
  assert.deepEqual(r.markets, []);
}

// ---- a tampered odds hash is flagged
{
  const r = buildRound(status("agents", { markets: [{ ...mv, odds_hash: "00".repeat(32) }] }), null);
  assert.equal(r.markets[0].oddsHashOk, false);
}

// ---- running: two colonies cranked so far
{
  const r = buildRound(status("running", { run: run(2) }));
  const m = r.markets[0];
  assert.equal(r.seed, seedHex);
  assert.equal(m.cranked, 2);
  assert.equal(m.done, false);
  assert.equal(m.swarm, null);
  assert.deepEqual(m.forecasters.map((f) => f.cranked), [true, true, false]);
  assert.deepEqual(m.forecasters.map((f) => f.counted), [true, true, true]);
  const v = await verifyMarket(m);
  assert.deepEqual(v.colonies.map((c) => c.state), ["match", "match", "pending"]);
  assert.equal(v.market, null);
  assert.equal(v.ok, true);
}

// ---- done: every hash, the market hash and the swarm belief reproduce
{
  const r = buildRound(status("done", { run: run(3) }));
  const m = r.markets[0];
  assert.equal(m.done, true);
  assert.deepEqual(m.swarm, truth.swarm);
  assert.equal(r.all.length, 3);
  const v = await verifyRound(r);
  assert.equal(v.ok, true);
  assert.equal(v.rows.length, 4);
  assert.ok(v.rows.every((x) => x.state === "match"), JSON.stringify(v.rows.map((x) => x.state)));
  assert.equal(v.markets[0].market.hashOk, true);
  assert.equal(v.markets[0].market.swarmOk, true);

  // One wrong colony hash is caught, and the market hash fails with it.
  const bad = run(3);
  bad.markets[0].colony_hashes[1] = "0".repeat(64);
  const vb = await verifyRound(buildRound(status("done", { run: bad })));
  assert.equal(vb.ok, false);
  assert.deepEqual(vb.rows.filter((x) => x.state === "mismatch").map((x) => x.kind), ["colony"]);
  // A wrong swarm belief is caught even when every colony matches.
  const badSwarm = run(3);
  badSwarm.markets[0].swarm = [3333, 3333, 3334];
  const vs = await verifyMarket(buildRound(status("done", { run: badSwarm })).markets[0]);
  assert.equal(vs.ok, false);
  assert.equal(vs.market.swarmOk, false);
}

// ---- an empty agents list and no stakes still reproduce (both colonies sit out)
{
  const quiet = forecastMarket(seed, 1, mv.odds, mv.odds_6h, [0, 0, 0], stakeBytes, [0, 0, 0], new Uint8Array(32));
  const rn = { round: 4, seed: seedHex, stake_hash: stakeHash, done: true, markets: [{
    colony: 1, weights: [0, 0, 0], agents: { odds: [0, 0, 0], hash: "0".repeat(64), posts: [] },
    colony_hashes: quiet.colonies.map((c) => c.hash), crankers: [], swarm: quiet.swarm, market_hash: quiet.hash }] };
  const m = buildRound(status("done", { run: rn })).markets[0];
  assert.deepEqual(m.forecasters.map((f) => f.counted), [true, false, false]);
  assert.equal((await verifyMarket(m)).ok, true);
}

// ---- the previous round shows while the current one has no run
{
  const last = { markets: [mv], run: run(3) };
  const r = buildRound(status("posting", { round: 5 }), last);
  assert.equal(r.id, 5);
  assert.equal(r.previous.id, 4);
  assert.equal(r.shown, r.previous);
  assert.equal(r.previous.markets[0].key, "p0");
  assert.equal(r.previous.markets[0].forecasters[0].key, "p0-momentum");
  assert.equal((await verifyRound(r.previous)).ok, true);
  // Once the current round runs, it is the one shown.
  const r2 = buildRound(status("running", { round: 5, run: run(1) }), last);
  assert.equal(r2.shown, r2);
}

// ---- staker wallets from the stake snapshot
{
  const entries = [
    ["a.testnet", 1, 0, (9n * ONE).toString()],
    ["b.testnet", 1, 2, (16n * ONE).toString()],
    ["b.testnet", 1, 0, (ONE / 2n).toString()],
    ["c.testnet", 7, 1, ONE.toString()],
  ];
  const ws = walletsFor(entries, 1, 3);
  assert.deepEqual(ws.map((w) => [w.id, w.stakes]), [["a.testnet", [9, 0, 0]], ["b.testnet", [0.5, 0, 16]]]);
}

// ---- loadRound reads through the stubbed views
{
  const calls = [];
  const call = async (method, args = {}) => {
    calls.push(method);
    if (method === "round_status") return status("agents");
    if (method === "last_round") return null;
    if (method === "stake_snapshot") return { hash: stakeHash, entries: [["a.testnet", marketColony(0), 0, (4n * ONE).toString()]] };
    if (method === "stake_totals") { assert.deepEqual(args, { colony: 1, n_options: 3 }); return [(4n * ONE).toString(), "0", "0"]; }
    throw new Error(`unexpected ${method}`);
  };
  const r = await loadRound({ call, now: 1_500 });
  assert.ok(calls.includes("stake_snapshot"), "snapshot read once staking has closed");
  assert.equal(r.phase, "agents");
  assert.equal(r.markets[0].stakes[0], (4n * ONE).toString());
  // Before the close, the snapshot is not requested (it would fail).
  calls.length = 0;
  await loadRound({ call, now: 500 });
  assert.ok(!calls.includes("stake_snapshot"));
  // A failing stake_snapshot does not break the page.
  const r3 = await loadRound({ call: async (m, a) => (m === "stake_snapshot" ? Promise.reject(new Error("boom")) : call(m, a)), now: 1_500 });
  assert.equal(r3.markets.length, 1);
}

console.log("round chain ok");

// A posting round has no accepted market yet: the keepers' own posts are the proposal.
{
  const { loadRound, proposalFromKeepers } = await import("./roundchain.mjs");
  const post = { market_id: "fed-decision", outcomes: ["Cut", "Hold"], odds: [6000, 4000], odds_6h: [5500, 4500], raw_hash: "ab".repeat(32) };
  const views = {
    round_status: { round: 3, phase: "posting", close_at_ms: 9e12, publish_at_ms: 9e12 + 1, markets: null, run: null },
    last_round: null,
    keepers: [["k1.t", "k2.t", "k3.t"], 2],
    keeper_post: ({ account_id }) => (account_id === "k3.t" ? null : [post]),
    stake_totals: ["0", "0"],
  };
  const call = async (m, a) => { const v = views[m]; return typeof v === "function" ? v(a) : v; };
  const prop = await proposalFromKeepers(call);
  assert.equal(prop.length, 1);
  assert.equal(prop[0].colony, 1);
  assert.equal(prop[0].raw_hashes.length, 2, "both posting keepers listed");
  assert.equal(prop[0].odds_hash.length, 64);
  const round = await loadRound({ call, now: 0 });
  assert.equal(round.proposed, true);
  assert.equal(round.markets.length, 1);
  assert.equal(round.markets[0].outcomes.join(), "Cut,Hold");
  // Nobody posted: no market, not proposed.
  views.keeper_post = null;
  assert.equal((await loadRound({ call, now: 0 })).proposed, false);
  // Once the contract has the market, it wins over any post.
  views.round_status = { ...views.round_status, markets: [{ colony: 1, market_id: "x", outcomes: ["A", "B"], odds: [5000, 5000], odds_6h: [5000, 5000], odds_hash: "00".repeat(32), raw_hashes: [] }] };
  views.keeper_post = [post];
  assert.equal((await loadRound({ call, now: 0 })).proposed, false);
  console.log("round chain proposal ok");
}
