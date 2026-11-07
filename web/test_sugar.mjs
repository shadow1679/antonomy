// Offline tests for drop sugar: node web/test_sugar.mjs
import assert from "node:assert/strict";
import { withSugar, sugarPreview, YOU, SUGAR_CAP } from "./sugar.mjs";
import { BURN_WALLETS } from "./round.mjs";
import { seedFromInt, trailShares } from "../sim/js/antosim.mjs";

const seed = seedFromInt(7);

const finish = (col) => { while (col.t < col.ticks) col.step(); return col.result(); };

// No sugar: the wallet list, weights and the whole run are the baseline.
assert.equal(withSugar(BURN_WALLETS, 2, 0), BURN_WALLETS);
const none = sugarPreview(seed, 2, 0);
assert.deepEqual(none.with.weights, none.without.weights);
assert.deepEqual(none.with.richness, none.without.richness);
assert.equal(finish(none.with.make()).hash, finish(none.without.make()).hash);

// Sugar adds sqrt weight to one option only; 25 tokens is 5 sqrt-tokens.
const p = sugarPreview(seed, 0, 25);
assert.equal(p.weight, 5000);
assert.deepEqual(p.with.weights, p.without.weights.map((w, o) => w + (o === 0 ? 5000 : 0)));
assert.equal(p.with.wallets.at(-1).id, YOU);
assert.ok(p.with.richness[0] > p.without.richness[0]);

// Square-root weighting: four times the stake is only twice the weight.
assert.equal(sugarPreview(seed, 0, 100).weight, 2 * sugarPreview(seed, 0, 25).weight);

// The extra wallet gets staker ants and the stake changes the result hash.
assert.ok(p.with.stakers.rows.at(-1).ants > 0);
assert.notEqual(finish(p.with.make()).hash, finish(p.without.make()).hash);
const r = finish(p.with.make());
assert.equal(trailShares(r).length, 5);

// Same inputs, same colony.
assert.equal(finish(p.with.make()).hash, finish(sugarPreview(seed, 0, 25).with.make()).hash);

// Bad input is rejected, including past the per-wallet cap.
assert.throws(() => withSugar(BURN_WALLETS, 5, 1), RangeError);
assert.throws(() => withSugar(BURN_WALLETS, 0, SUGAR_CAP + 1), RangeError);
assert.throws(() => withSugar(BURN_WALLETS, 0, 1.5), RangeError);
console.log("drop sugar: ok");
