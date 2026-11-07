// Offline tests for check the receipts: node web/test_receipts.mjs
// The chain is canned JSON (test_chain_fixture.mjs) run through the round adapter.
import assert from "node:assert/strict";
import { issueReceipt, checkReceipt, parseReceipt, roundFromChain, SPEC } from "./receipts.mjs";
import { buildRound } from "./roundchain.mjs";
import { cannedRound } from "./test_chain_fixture.mjs";

const flip = (h) => (h[0] === "0" ? "1" : "0") + h.slice(1);

const a = cannedRound(7), b = cannedRound(8);
const status = (r, phase = "done") => ({ round: r.run.round, phase, close_at_ms: 1, publish_at_ms: 2, markets: [r.mv], run: r.run });
// Round 8 is current and finished; round 7 is the previous one.
const loaded = buildRound(status(b), { markets: [a.mv], run: a.run });
const round8 = roundFromChain(loaded, 8), round7 = roundFromChain(loaded, 7);
assert.equal(round8, loaded);
assert.equal(round7, loaded.previous);
assert.equal(roundFromChain(loaded, 3), null, "the chain keeps only two rounds");

// Issuing reads the chain: seed, 5 colony hashes, one market hash.
const receipt = issueReceipt(loaded, 7, "antonomy-oracle.testnet");
assert.equal(receipt.spec, SPEC);
assert.equal(receipt.round, 7);
assert.equal(receipt.seed, a.run.seed);
assert.equal(receipt.colonies.length, 5);
assert.deepEqual(receipt.colonies.map((c) => c.key), ["m0-follower", "m0-contrarian", "m0-momentum", "m0-community", "m0-agents"]);
assert.deepEqual(receipt.colonies.map((c) => c.hash), a.run.markets[0].colony_hashes);
assert.deepEqual(receipt.markets, [{ market: 0, hash: a.run.markets[0].market_hash }]);
assert.equal(issueReceipt(loaded).round, 8, "default: the newest round with a result");

// An honest receipt checks out on every row, whether the round is current or previous.
const ok = await checkReceipt(parseReceipt(JSON.stringify(receipt)), round7);
assert.equal(ok.ok, true);
assert.equal(ok.rows.length, 1 + 5 + 1);
assert.ok(ok.rows.every((r) => r.state === "match"));
assert.equal((await checkReceipt(issueReceipt(loaded, 8), round8)).ok, true);

// The same receipt does not pass for another round's inputs.
const wrongRound = await checkReceipt({ ...receipt, round: 8 }, round8);
assert.equal(wrongRound.ok, false);
assert.ok(wrongRound.rows.every((r) => r.state === "mismatch"));

// One flipped hex digit in one colony is caught, and only that row fails.
const bad = structuredClone(receipt);
bad.colonies[2].hash = flip(bad.colonies[2].hash);
const res = await checkReceipt(bad, round7);
assert.equal(res.ok, false);
assert.deepEqual(res.rows.filter((r) => r.state !== "match").map((r) => r.key), ["m0-momentum"]);

// A tampered market hash and a tampered seed are caught too.
const badMarket = structuredClone(receipt);
badMarket.markets[0].hash = flip(badMarket.markets[0].hash);
assert.deepEqual((await checkReceipt(badMarket, round7)).rows.filter((r) => r.state !== "match").map((r) => r.kind), ["market"]);
assert.equal((await checkReceipt({ ...receipt, seed: flip(receipt.seed) }, round7)).rows[0].state, "mismatch");

// Missing and unknown entries never pass; uppercase and 0x forms are accepted.
const partial = structuredClone(receipt);
const dropped = partial.colonies.shift();
partial.colonies.push({ key: "ghost", hash: "ab".repeat(32) });
partial.markets[0].hash = "0x" + partial.markets[0].hash.toUpperCase();
const pr = await checkReceipt(partial, round7);
assert.equal(pr.ok, false);
assert.equal(pr.rows.find((r) => r.key === dropped.key).state, "missing");
assert.equal(pr.rows.find((r) => r.key === "ghost").state, "extra");
assert.equal(pr.rows.find((r) => r.kind === "market").state, "match");

// A hash that isn't 64 hex characters counts as missing, not as a match.
const junk = structuredClone(receipt);
junk.colonies[0].hash = "nope";
assert.equal((await checkReceipt(junk, round7)).rows.find((r) => r.key === junk.colonies[0].key).state, "missing");

// A half-cranked round: only what the chain has can be checked, and it matches.
const half = buildRound({ ...status(cannedRound(9, { cranked: 2 }), "running") });
const hr = issueReceipt(half, 9);
assert.equal(hr.colonies.length, 2);
assert.equal(hr.markets.length, 0);
const hc = await checkReceipt(hr, half);
assert.equal(hc.ok, true);
assert.equal(hc.rows.length, 1 + 2);

// No result on the chain: nothing to issue or check.
const posting = buildRound({ round: 10, phase: "posting", close_at_ms: 1, publish_at_ms: 2, markets: [a.mv], run: null });
assert.throws(() => issueReceipt(posting), RangeError);
await assert.rejects(checkReceipt(receipt, posting), RangeError);

// Malformed receipts are rejected before any colony runs.
for (const text of ["", "[]", "null", "{", JSON.stringify({ ...receipt, spec: "ANTO-SIM-v0" }),
  JSON.stringify({ ...receipt, round: -1 }), JSON.stringify({ ...receipt, round: 1.5 }),
  JSON.stringify({ ...receipt, seed: "abc" }), JSON.stringify({ ...receipt, colonies: null })]) {
  assert.throws(() => parseReceipt(text), RangeError, text);
}

// The progress callback sees every cranked colony once, in order.
const seen = [];
await checkReceipt(receipt, round7, { onColony: (s, i, n) => seen.push([s.name, i, n]) });
assert.deepEqual(seen.map((x) => x[0]), ["Follower", "Contrarian", "Momentum", "Community", "Agents"]);
assert.ok(seen.every((x, i) => x[1] === i && x[2] === 5));

console.log("receipts ok");
