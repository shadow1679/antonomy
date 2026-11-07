// Offline tests for web/automation.mjs. Run: node web/test_automation.mjs
import assert from "node:assert/strict";
import { automationRows } from "./automation.mjs";

const [k, a, c] = automationRows({
  keepers: [{ id: "keeper.t", posted: true }, { id: "k2.t", posted: false }], quorum: 1,
  agents: [{ id: "agent.t", posts: 2 }], marketCount: 3,
  cranks: ["cranker.t", "cranker.t", "bob.t"], total: 15,
});
assert.equal(k.status, "1 of 2 posted · quorum 1");
assert.deepEqual(k.accounts.map((x) => x.note), ["posted", "waiting"]);
assert.equal(a.status, "1 agent registered · 3 markets open to post on");
assert.equal(a.accounts[0].note, "posted on 2 of 3");
assert.equal(c.status, "3 of 15 colonies cranked");
assert.deepEqual(c.accounts, [{ id: "cranker.t", note: "2 colonies" }, { id: "bob.t", note: "1 colony" }]);

// Empty chain: honest text, no rows.
const [k0, a0, c0] = automationRows({ keepers: [], quorum: 0, agents: [], marketCount: 0, cranks: [], total: 0 });
assert.equal(k0.status, "none allow-listed");
assert.equal(a0.status, "no forecaster agents registered");
assert.equal(c0.status, "no colonies to run yet");
assert.deepEqual([k0, a0, c0].map((r) => r.accounts.length), [0, 0, 0]);

// Posts unknown or no markets yet: only "registered".
assert.equal(automationRows({ keepers: [], quorum: 1, agents: [{ id: "x.t", posts: null }], marketCount: 2, cranks: [], total: 0 })[1].accounts[0].note, "registered");
console.log("automation tests passed");
