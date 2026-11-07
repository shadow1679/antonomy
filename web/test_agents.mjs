// Offline tests for the agent-odds snapshot: node web/test_agents.mjs
import assert from "node:assert/strict";
import { toHex } from "../sim/js/antosim.mjs";
import { agentSnapshot, lowerMedian, checkPost, weightedMedian, commitHash } from "./agents.mjs";

// The vector the contract's tests use.
const posts = [
  { id: "c3.testnet", odds: [3000, 3000, 4000] },
  { id: "a1.testnet", odds: [6000, 3000, 1000] },
  { id: "b2.testnet", odds: [5000, 4000, 1000] },
];
const s = agentSnapshot(posts, 3);
assert.deepEqual(s.odds, [5000, 3000, 1000]);
assert.equal(toHex(s.hash), "b04dce28ad9489ae08cc9860c154b76b4b1d7394607b719b803822e25d4b7821");
assert.deepEqual(s.agents, ["a1.testnet", "b2.testnet", "c3.testnet"]);
// Post order doesn't matter.
assert.deepEqual(agentSnapshot([...posts].reverse(), 3), s);

// No posts: an even map and a zero hash.
const none = agentSnapshot([], 2);
assert.deepEqual(none.odds, [0, 0]);
assert.equal(toHex(none.hash), "0".repeat(64));

// Lower median with an even count.
assert.equal(lowerMedian([7000, 6000]), 6000);
assert.equal(lowerMedian([1, 9, 5, 3]), 3);

// Bad posts are rejected.
assert.throws(() => checkPost([5000, 4000], 2), RangeError);
assert.throws(() => checkPost([10000], 2), RangeError);
assert.throws(() => checkPost([10001, -1], 2), RangeError);
checkPost([10000, 0], 2);

// Skill weights (token/src/agents.rs shared vectors): c3's record carries the
// median, and unequal weights go into the hash. Equal weights change nothing.
assert.deepEqual(agentSnapshot(posts, 3, [1000, 1000, 1000]), s);
const w = agentSnapshot(posts, 3, [1000, 1000, 4000]);
assert.deepEqual(w.odds, [3000, 3000, 4000]);
assert.equal(toHex(w.hash), "3daf27ecc89cba6a784c616e40c16dd6b6052954ed0a59ff7f8b502a57f63cb2");
assert.throws(() => agentSnapshot(posts, 3, [1000, 1000]), RangeError);
assert.equal(weightedMedian([3000, 5000, 6000], [4000, 1000, 1000]), 3000);
assert.equal(weightedMedian([1, 2, 3, 4], [7, 7, 7, 7]), 2);

// Commit, then reveal: the hash an agent commits.
assert.equal(commitHash(1, [7000, 3000], new Uint8Array(32).fill(9), "a1.testnet"),
  "5fb2951fc420fe264f4375b17870f73825aac178e29c1819ccd17f276f47b6c8");

console.log("agents: all tests passed");
