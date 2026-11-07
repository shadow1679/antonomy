// Offline tests for check the receipts: node web/test_receipts.mjs
import assert from "node:assert/strict";
import { issueReceipt, checkReceipt, parseReceipt, SPEC } from "./receipts.mjs";
import { roundById } from "./round.mjs";

const flip = (h) => (h[0] === "0" ? "1" : "0") + h.slice(1);

const round = roundById(7);
const receipt = await issueReceipt(round);

// Shape: seed, 4 forecasters, 1 market hash. Burn runs per day, not per round.
assert.equal(receipt.spec, SPEC);
assert.equal(receipt.round, 7);
assert.equal(receipt.colonies.length, round.all.length);
assert.equal(receipt.markets.length, round.markets.length);
assert.match(receipt.seed, /^[0-9a-f]{64}$/);

// Issuing is deterministic, and an honest receipt checks out on every row.
assert.deepEqual(await issueReceipt(roundById(7)), receipt);
const ok = await checkReceipt(parseReceipt(JSON.stringify(receipt)));
assert.equal(ok.ok, true);
assert.equal(ok.rows.length, 1 + round.all.length + round.markets.length);
assert.ok(ok.rows.every((r) => r.state === "match"));

// A different round has different hashes, so its receipt fails against round 7.
const other = await issueReceipt(roundById(8));
const wrongRound = await checkReceipt({ ...other, round: 7 });
assert.equal(wrongRound.ok, false);
assert.ok(wrongRound.rows.every((r) => r.state === "mismatch"));

// One flipped hex digit in one colony is caught, and only that row fails.
const bad = structuredClone(receipt);
bad.colonies[2].hash = flip(bad.colonies[2].hash);
const res = await checkReceipt(bad);
assert.equal(res.ok, false);
assert.deepEqual(res.rows.filter((r) => r.state !== "match").map((r) => r.key), [bad.colonies[2].key]);

// A tampered market hash and a tampered seed are caught too.
const badMarket = structuredClone(receipt);
badMarket.markets[0].hash = flip(badMarket.markets[0].hash);
assert.deepEqual((await checkReceipt(badMarket)).rows.filter((r) => r.state !== "match").map((r) => r.kind), ["market"]);
const badSeed = { ...receipt, seed: flip(receipt.seed) };
assert.equal((await checkReceipt(badSeed)).rows[0].state, "mismatch");

// Missing and unknown entries never pass; uppercase and 0x forms are accepted.
const partial = structuredClone(receipt);
const dropped = partial.colonies.shift();
partial.colonies.push({ key: "ghost", hash: "ab".repeat(32) });
partial.markets[0].hash = "0x" + partial.markets[0].hash.toUpperCase();
const pr = await checkReceipt(partial);
assert.equal(pr.ok, false);
assert.equal(pr.rows.find((r) => r.key === dropped.key).state, "missing");
assert.equal(pr.rows.find((r) => r.key === "ghost").state, "extra");
assert.equal(pr.rows.find((r) => r.kind === "market").state, "match");

// A hash that isn't 64 hex characters counts as missing, not as a match.
const junk = structuredClone(receipt);
junk.colonies[0].hash = "nope";
assert.equal((await checkReceipt(junk)).rows.find((r) => r.key === junk.colonies[0].key).state, "missing");

// Malformed receipts are rejected before any colony runs.
for (const text of ["", "[]", "null", "{", JSON.stringify({ ...receipt, spec: "ANTO-SIM-v0" }),
  JSON.stringify({ ...receipt, round: -1 }), JSON.stringify({ ...receipt, round: 1.5 }),
  JSON.stringify({ ...receipt, seed: "abc" }), JSON.stringify({ ...receipt, colonies: null })]) {
  assert.throws(() => parseReceipt(text), RangeError, text);
}

// The progress callback sees every colony once, in order.
const seen = [];
await checkReceipt(receipt, { onColony: (s, i, n) => seen.push([s.key, i, n]) });
assert.deepEqual(seen.map((x) => x[0]), round.all.map((s) => s.key));
assert.ok(seen.every((x, i) => x[1] === i && x[2] === round.all.length));

console.log("receipts ok");
