// Offline tests for web/random.mjs. Run: node web/test_random.mjs
import assert from "node:assert/strict";
import {
  randomValue, randomnessOf, pickIndex, parseChoices, stage, verifyRequest, publishedAt, consumerSnippet, newestFirst,
  secondsLeft, steps, returnValueOf,
} from "./random.mjs";

// Real quicknet beacons (contract/src/drand.rs): signature -> randomness.
const R1 = { sig: "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b", rand: "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a" };
const R2 = { sig: "b6b6a585449b66eb12e875b64fcbab3799861a00e4dbf092d99e969a5eac57dd3f798acf61e705fe4f093db926626807", rand: "5782d6987841c654515a0e72b2d1ebb4e741234042c37cb19608ae50d93fb60c" };
const ORACLE = "antonomy-oracle.testnet";

assert.equal(randomnessOf(R1.sig), R1.rand);
assert.equal(randomnessOf(R2.sig), R2.rand);

// The vectors token/src/random.rs asserts too (made with Python's hashlib).
assert.equal(randomValue(R1.rand, 0, "alice.testnet", ORACLE), "5de4e3a2ea9b1f2f5c418f4505c40becb903c8dd059db6892520fbfa0dde9064");
assert.equal(randomValue(R1.rand, 7, "consumer.testnet", ORACLE), "db7d1402453fbcab7f4ec38323f08122caf0263ccfd23c0848568c241a56fc2f");
// Every input matters, and the account lengths are part of the hash.
const base = randomValue(R1.rand, 0, "ab", "c");
assert.notEqual(base, randomValue(R1.rand, 0, "a", "bc"));
assert.notEqual(base, randomValue(R2.rand, 0, "ab", "c"));
assert.notEqual(base, randomValue(R1.rand, 1, "ab", "c"));
assert.throws(() => randomValue("zz", 0, "a", "b"), RangeError);

// pick: the hash read as a big-endian integer, mod n.
const v10 = "0".repeat(62) + "0a";
assert.equal(pickIndex(v10, 3), 1);
assert.equal(pickIndex(v10, 1), 0);
assert.equal(pickIndex("0".repeat(60) + "010a", 7), 266 % 7);
assert.equal(pickIndex("01" + "0".repeat(62), 5), 1); // 2^248 mod 5
assert.equal(pickIndex("f".repeat(64), 10), Number((2n ** 256n - 1n) % 10n));
assert.throws(() => pickIndex(v10, 0), RangeError);
assert.throws(() => pickIndex("abc", 3), RangeError);
// Every index turns up.
const seen = new Set();
for (let id = 0; id < 200; id++) seen.add(pickIndex(randomValue(R1.rand, id, "a", "c"), 5));
assert.equal(seen.size, 5);

// Choices: split on lines and commas, trimmed, deduplicated, order kept.
assert.deepEqual(parseChoices("Ann, Bo\n  Cy ,, Ann\n\n"), ["Ann", "Bo", "Cy"]);
assert.deepEqual(parseChoices(""), []);
assert.equal(parseChoices("x".repeat(100))[0].length, 40);
assert.equal(parseChoices(Array.from({ length: 300 }, (_, i) => "n" + i).join("\n")).length, 100);

// Stages follow the clock and the chain's status.
assert.equal(publishedAt(1), 1_692_803_367_000);
assert.equal(publishedAt(3), 1_692_803_373_000);
const pending = { id: 0, requester: "alice.testnet", drand_round: 100, status: "pending", randomness: null, value: null };
assert.equal(stage(pending, publishedAt(100) - 1), "waiting");
assert.equal(stage(pending, publishedAt(100)), "unproven");
assert.equal(stage({ ...pending, status: "ready" }, 0), "ready");
assert.equal(secondsLeft(pending, publishedAt(100) - 2500), 3);
assert.equal(secondsLeft(pending, publishedAt(100) + 1), 0);
const st = (req, now) => steps(req, now).map((s) => s.state);
assert.deepEqual(st(pending, publishedAt(100) - 1), ["done", "now", "todo"]);
assert.deepEqual(st(pending, publishedAt(100)), ["done", "done", "now"]);
assert.deepEqual(st({ ...pending, status: "ready" }, 0), ["done", "done", "done"]);
assert.match(steps(pending, 0)[1].label, /round 100/);

// The id request_randomness returns, from the wallet's outcome.
assert.equal(returnValueOf({ status: { SuccessValue: btoa("7") } }), 7);
assert.equal(returnValueOf({ status: { SuccessValue: btoa("0") } }), 0);
assert.equal(returnValueOf({ status: { SuccessValue: "" } }), null);
assert.equal(returnValueOf({ status: { Failure: {} } }), null);
assert.equal(returnValueOf({ status: { SuccessValue: "!!" } }), null);
assert.equal(returnValueOf(undefined), null);

// Verifying a ready request against drand's signature.
const ready = {
  id: 0, requester: "alice.testnet", drand_round: 1, status: "ready",
  randomness: R1.rand, value: "5de4e3a2ea9b1f2f5c418f4505c40becb903c8dd059db6892520fbfa0dde9064",
};
{
  const ok = verifyRequest(ready, ORACLE, R1.sig);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rows.map((r) => r.state), ["match", "match"]);
  // A value the chain made up, or randomness for another round: mismatch.
  const bad = verifyRequest({ ...ready, value: "00".repeat(32) }, ORACLE, R1.sig);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.rows.map((r) => r.state), ["match", "mismatch"]);
  const wrongRound = verifyRequest(ready, ORACLE, R2.sig);
  assert.deepEqual(wrongRound.rows.map((r) => r.state), ["mismatch", "match"]);
  // drand unreachable: the first row is missing, not a failure to match.
  const offline = verifyRequest(ready, ORACLE, null);
  assert.deepEqual(offline.rows.map((r) => r.state), ["missing", "match"]);
  assert.equal(offline.ok, false);
  // A request that is not ready has nothing to verify.
  assert.deepEqual(verifyRequest(pending, ORACLE, R1.sig), { ok: false, rows: [] });
}

assert.match(consumerSnippet(ORACLE), /request_randomness/);
assert.match(consumerSnippet(ORACLE), new RegExp(ORACLE));
assert.deepEqual(newestFirst([{ id: 1 }, { id: 3 }, { id: 2 }]).map((r) => r.id), [3, 2, 1]);

console.log("random ok");
