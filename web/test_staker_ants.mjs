// Offline tests for staker ants: node web/test_staker_ants.mjs
import assert from "node:assert/strict";
import { stakeWeight, walletHue, walletWeights, stakerAnts, ANTS_PER_SQRT_TOKEN } from "./ds/staker-ants.mjs";
import { roundColonies, burnColony } from "./round.mjs";
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
const burn = burnColony(seedFromInt(1)).stakers;
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

console.log("staker ants: ok");
