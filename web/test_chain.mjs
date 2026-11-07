// web/chain.mjs read behaviour: sharing, pacing and retry against a rate-limited RPC.
// Offline: globalThis.fetch is replaced by a fake. Run: node web/test_chain.mjs
import assert from "node:assert/strict";
import { view, invalidate, MAX_PARALLEL, RPCS } from "./chain.mjs";

const enc = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const ok = (v) => ({ json: async () => ({ result: { result: enc(v) } }) });
const real = globalThis.fetch;
let calls, inFlight, peak;

function install(handler) {
  calls = []; inFlight = 0; peak = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: JSON.parse(init.body).params.method_name });
    inFlight++; peak = Math.max(peak, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return handler(url, calls.length);
    } finally { inFlight--; }
  };
}

try {
  // 1. Identical reads share one request; a later read within the window too.
  install(() => ok({ a: 1 }));
  invalidate();
  const [x, y] = await Promise.all([view("round_status"), view("round_status")]);
  assert.deepEqual([x, y], [{ a: 1 }, { a: 1 }]);
  await view("round_status");
  assert.equal(calls.length, 1, "three reads, one request");
  // fresh: true skips the cache; different args are different reads.
  await view("round_status", {}, { fresh: true });
  await view("stake_totals", { colony: 1, n_options: 3 });
  assert.equal(calls.length, 3);

  // 2. Never more than MAX_PARALLEL reads at once.
  install(() => ok(1));
  invalidate();
  await Promise.all(Array.from({ length: 12 }, (_, i) => view("m", { i })));
  assert.ok(peak <= MAX_PARALLEL && peak > 1, `peak ${peak}`);

  // 3. A 429 (no CORS header, so fetch rejects) on the first endpoint falls to the second.
  install((url) => { if (url === RPCS[0]) throw new TypeError("Failed to fetch"); return ok("second"); });
  invalidate();
  assert.equal(await view("round_status"), "second");
  assert.equal(calls[0].url, RPCS[0]);
  assert.equal(calls[1].url, RPCS[1]);

  // 4. Every endpoint failing once: it pauses and retries, then succeeds.
  install((url, n) => { if (n <= RPCS.length) throw new TypeError("Failed to fetch"); return ok("recovered"); });
  invalidate();
  assert.equal(await view("round_status"), "recovered");
  assert.ok(calls.length > RPCS.length);

  // 5. A failed read is not cached: the next call asks again.
  install(() => { throw new TypeError("Failed to fetch"); });
  invalidate();
  await assert.rejects(view("round_status"));
  install(() => ok("back"));
  assert.equal(await view("round_status"), "back");
  assert.ok(calls.length >= 1);

  // 6. A custom fetchFn (tests of other modules) bypasses the cache entirely.
  let n = 0;
  const f = async () => ({ json: async () => ({ result: { result: enc(++n) } }) });
  assert.equal(await view("x", {}, { fetchFn: f }), 1);
  assert.equal(await view("x", {}, { fetchFn: f }), 2);
  console.log("chain reads: ok");
} finally {
  globalThis.fetch = real;
}
