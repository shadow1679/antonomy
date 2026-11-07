// Offline tests for web/autocrank.mjs. Run: node web/test_autocrank.mjs
import assert from "node:assert/strict";
import { createAutoCrank, isRefusal } from "./autocrank.mjs";

function rig({ steps, send }) {
  const log = [], said = [];
  const a = createAutoCrank({
    next: () => steps.shift() ?? null,
    send: async (s) => { log.push(s.method); await send?.(s); },
    refresh: async () => { log.push("refresh"); },
    say: (t) => said.push(t),
    wait: async () => {},
  });
  return { a, log, said };
}

// Off by default: nothing is sent.
{
  const { a, log } = rig({ steps: [{ method: "crank_round" }] });
  assert.equal(await a.poll(), null);
  assert.deepEqual(log, []);
}
// On: sends the due call, refreshes, and does nothing when nothing is due.
{
  const { a, log } = rig({ steps: [{ method: "crank_round" }] });
  await a.set(true);
  assert.deepEqual(log, ["crank_round", "refresh"]);
  assert.equal(await a.poll(), null);
}
// One call at a time: a second poll while one is in flight is a no-op.
{
  let release;
  const gate = new Promise((r) => (release = r));
  const { a, log } = rig({ steps: [{ method: "a" }, { method: "b" }], send: () => gate });
  a.set(true);
  await Promise.resolve();
  assert.equal(await a.poll(), null);
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log.filter((x) => x === "a" || x === "b"), ["a", "b"]);
}
// A refusal switches it off at once.
{
  const { a, said } = rig({ steps: [{ method: "x" }, { method: "x" }], send: async () => { throw new Error("User rejected the request"); } });
  await a.set(true);
  assert.equal(a.on, false);
  assert.match(said.at(-1), /refused/);
}
// Other errors: it keeps trying, then stops after three in a row.
{
  const { a, said } = rig({ steps: Array.from({ length: 5 }, () => ({ method: "x" })), send: async () => { throw new Error("boom"); } });
  await a.set(true);
  assert.equal(a.on, true);
  await a.poll();
  assert.equal(a.on, true);
  await a.poll();
  assert.equal(a.on, false);
  assert.match(said.at(-1), /boom/);
}
assert.ok(isRefusal(new Error("Wallet closed")) && !isRefusal(new Error("gas")));
console.log("autocrank tests passed");
