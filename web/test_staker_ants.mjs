// Offline tests for staker ants: node web/test_staker_ants.mjs
import assert from "node:assert/strict";
import { stakeWeight, walletHue, walletWeights, stakerAnts, agentAnts, ANTS_PER_SQRT_TOKEN } from "./ds/staker-ants.mjs";
import { marketForecasters } from "./round.mjs";
import { stakerLegendHTML, followHTML } from "./ui.mjs";
import { burnColony } from "./round.mjs";
import { roundColonies } from "./fixtures.mjs";
import { seedFromInt, N_ANTS, FORECAST_ANTS } from "../sim/js/antosim.mjs";

// Weight is the floor of 1000 * sqrt(tokens), as the contract's sim_weights.
assert.equal(stakeWeight(0), 0);
assert.equal(stakeWeight(4), 2000);
assert.equal(stakeWeight(16), 4000);
assert.equal(stakeWeight(2), 1414);

// Hue is in range and depends on the account id only.
for (const id of ["alice.testnet", "bob.testnet", "x"]) {
  const h = walletHue(id);
  assert.ok(Number.isInteger(h) && h >= 0 && h < 360);
  assert.equal(h, walletHue(id));
}

// Fixture weights are unchanged by deriving them from wallets.
const round = roundColonies(seedFromInt(1));
assert.deepEqual(walletWeights([{ id: "a", stakes: [0, 4, 9] }, { id: "b", stakes: [0, 4, 0] }], 3), [0, 4000, 3000]);

// Burn: 15 sqrt-tokens -> 45 staker ants out of 150, and every ant is owned at most once.
const burnWallets = [
  { id: "alice.testnet", stakes: [0, 4, 0, 0, 0] }, { id: "bob.testnet", stakes: [0, 4, 0, 0, 0] },
  { id: "carol.testnet", stakes: [0, 0, 9, 0, 0] }, { id: "dave.testnet", stakes: [0, 0, 9, 0, 0] },
  { id: "erin.testnet", stakes: [0, 0, 9, 0, 0] }, { id: "frank.testnet", stakes: [0, 0, 0, 4, 0] },
];
const burn = burnColony(seedFromInt(1), { wallets: burnWallets }).stakers;
assert.equal(burn.total, 15000);
assert.equal(burn.owner.length, N_ANTS);
assert.equal(burn.rows.reduce((a, r) => a + r.ants, 0), 15 * ANTS_PER_SQRT_TOKEN);
assert.equal(burn.owner.filter((o) => o >= 0).length, 45);
for (const r of burn.rows) assert.equal(burn.owner.filter((o) => o === r.i).length, r.ants);

// Square-root weighting: 4x the stake is 2x the ants, not 4x.
const two = stakerAnts([{ id: "small", stakes: [4] }, { id: "big", stakes: [16] }], 150);
assert.equal(two.rows[1].ants, 2 * two.rows[0].ants);

// Splitting one stake over k wallets multiplies the ants by about sqrt(k).
const whole = stakerAnts([{ id: "w", stakes: [100] }], 150).rows[0].ants;
const split = stakerAnts(Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, stakes: [25] })), 150);
assert.equal(split.rows.reduce((a, r) => a + r.ants, 0), 2 * whole);

// No stakes means no staker ants. The budget never exceeds the colony.
assert.ok(stakerAnts([], 150).owner.every((o) => o === -1));
assert.equal(stakerAnts([{ id: "w", stakes: [10000] }], 60).owner.filter((o) => o >= 0).length, 60);

// Only the Community forecaster of a market has staker ants.
for (const f of round.markets[0].forecasters) {
  assert.equal(f.stakers !== null, f.name === "Community");
  if (f.stakers) assert.equal(f.stakers.owner.length, FORECAST_ANTS);
}

// Same stakes, same assignment.
assert.deepEqual(stakerAnts(burn.rows.map((r) => ({ id: r.id, stakes: [r.tokens] })), 150).owner,
  stakerAnts(burn.rows.map((r) => ({ id: r.id, stakes: [r.tokens] })), 150).owner);

// Agent ants: the Agents colony splits evenly over the agents whose posts
// counted (the median weighs each the same), the remainder to the lowest index.
const posts = [["a.testnet", [6000, 4000]], ["b.testnet", [5000, 5000]], ["c.testnet", [2000, 8000]], ["d.testnet", [7000, 3000]],
  ["e.testnet", [5500, 4500]], ["f.testnet", [4000, 6000]], ["g.testnet", [3000, 7000]]];
const ag = agentAnts(posts, FORECAST_ANTS);
assert.equal(ag.kind, "agent");
assert.equal(ag.total, 7);
assert.deepEqual(ag.rows.map((r) => r.ants), [9, 9, 9, 9, 8, 8, 8]);
assert.ok(ag.owner.every((o) => o >= 0), "every ant belongs to an agent");
assert.equal(ag.owner[0], 0);
assert.equal(ag.owner[FORECAST_ANTS - 1], 6);
assert.equal(ag.rows[2].hue, walletHue("c.testnet"));
assert.deepEqual(ag.rows[3].odds, [7000, 3000]);
const none = agentAnts([], FORECAST_ANTS);
assert.ok(none.total === 0 && none.owner.every((o) => o === -1));
// More agents than ants: the lowest indices get one ant each.
assert.equal(agentAnts(posts, 4).rows.filter((r) => r.ants).length, 4);

// marketForecasters gives Agents its agent ants once the posts are known,
// and leaves its hash alone (ants are a view, the sim never sees them).
const mk = (agentPosts) => marketForecasters(seedFromInt(7), 0x8000, {
  title: "t", outcomes: ["Yes", "No"], odds: [6000, 4000], odds6h: [6000, 4000], weights: [0, 0], wallets: [],
  agentOdds: { odds: [5000, 5000], hash: new Uint8Array(32), posts: agentPosts },
}, "r0");
const fs = mk(posts.slice(0, 2)), bare = mk(undefined);
assert.equal(fs[4].stakers.kind, "agent");
assert.equal(bare[4].stakers, null);
assert.equal(fs[3].stakers, null, "Community has no stakes here");
const run = (f) => { const c = f.make(); while (c.step()); return c.result().hash; };
assert.equal(run(fs[4]), run(bare[4]));

// The roster and the follow card show what the agent posted.
const legend = stakerLegendHTML(ag, ["Yes", "No"]);
assert.ok(legend.includes("a.testnet") && legend.includes("60.0%") && !legend.includes("tANTO"));
const card = followHTML({ a: 0, col: { t: 0 }, trips: [], labels: ["Yes", "No"], stakers: ag });
assert.ok(card.includes("agent ant · a.testnet") && card.includes("No Brier history yet"));

console.log("staker ants: ok");
