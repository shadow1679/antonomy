// Offline tests for the sugar preview: node web/test_sugar.mjs
import assert from "node:assert/strict";
import { withSugar, sugarPreview, othersWallet, YOU, OTHERS, SUGAR_CAP, SAMPLE_DAY_SEED } from "./sugar.mjs";
import { stakeWeight } from "./ds/staker-ants.mjs";
import { seedFromInt, trailShares } from "../sim/js/antosim.mjs";

const seed = seedFromInt(7);
const finish = (col) => { while (col.t < col.ticks) col.step(); return col.result(); };

// What the contract reports: all wallets' weights (milli sqrt-tokens) and the
// connected wallet's own stakes in tokens.
const chainBase = { weights: [0, 4000, 9000, 2000, 0], mine: [0, 0, 0, 0, 0], id: "me.testnet" };

// No sugar: both sides are the baseline, hash for hash.
const none = sugarPreview(seed, 2, 0, chainBase);
assert.deepEqual(none.with.weights, none.without.weights);
assert.deepEqual(none.with.richness, none.without.richness);
assert.equal(finish(none.with.make()).hash, finish(none.without.make()).hash);
assert.equal(none.weight, 0);

// Sugar adds sqrt weight to one option only; 25 tokens is 5 sqrt-tokens.
const p = sugarPreview(seed, 0, 25, chainBase);
assert.equal(p.weight, 5000);
assert.deepEqual(p.with.weights, p.without.weights.map((w, o) => w + (o === 0 ? 5000 : 0)));
assert.equal(p.with.wallets.at(-1).id, "me.testnet");
assert.equal(p.with.wallets[0].id, OTHERS);
assert.ok(p.with.richness[0] > p.without.richness[0]);

// Square-root weighting: four times the stake is only twice the weight.
assert.equal(sugarPreview(seed, 0, 100, chainBase).weight, 2 * sugarPreview(seed, 0, 25, chainBase).weight);

// A wallet that already has sugar on the option gains less from the same extra sugar.
const held = { ...chainBase, weights: [0, 4000 + 5000, 9000, 2000, 0], mine: [0, 25, 0, 0, 0] };
const more = withSugar(held, 1, 75);
assert.equal(more.withWeights[1], 4000 + stakeWeight(100)); // others' 4000 plus sqrt(100)
assert.equal(sugarPreview(seed, 1, 75, held).weight, stakeWeight(100) - stakeWeight(25));

// The extra wallet gets staker ants, the other wallets are one group, and the stake changes the result hash.
assert.ok(p.with.stakers.rows.at(-1).ants > 0);
assert.equal(p.without.stakers.rows.some((r) => r.id === "me.testnet"), false);
assert.notEqual(finish(p.with.make()).hash, finish(p.without.make()).hash);
assert.equal(trailShares(finish(p.with.make())).length, 5);
// The "other wallets" row carries exactly the chain's weights.
for (const w of [[0, 6527, 0, 8000, 707], [1, 2, 3, 4, 5]]) {
  assert.deepEqual(othersWallet(w).stakes.map(stakeWeight), w);
}

// Same inputs, same colony; an empty chain (no stakes) is an even map with no staker ants.
assert.equal(finish(p.with.make()).hash, finish(sugarPreview(seed, 0, 25, chainBase).with.make()).hash);
const empty = sugarPreview(seed, 0, 0, undefined);
assert.equal(empty.without.stakers.total, 0);
assert.ok(empty.without.richness.every((x) => x === empty.without.richness[0]));
assert.equal(SAMPLE_DAY_SEED.length, 32);
assert.equal(YOU, "you");

// Bad input is rejected, including past the per-wallet cap.
assert.throws(() => withSugar(chainBase, 5, 1), RangeError);
assert.throws(() => withSugar(chainBase, 0, SUGAR_CAP + 1), RangeError);
assert.throws(() => withSugar(chainBase, 0, 30, 25), RangeError);
assert.throws(() => withSugar(chainBase, 0, 1.5), RangeError);
console.log("sugar preview: ok");
