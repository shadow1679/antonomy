// Offline tests for the landing page's pure parts: node web/test_landing.mjs
import assert from "node:assert/strict";
import { FORECAST_TICKS } from "../sim/js/antosim.mjs";
import { verifyMarket } from "./roundchain.mjs";
import { RECORDED, recordedMarket, storyTick, stepTick, heroCell, summaryText, HERO_TPS } from "./landing.mjs";

// Round 4's recording replays to the chain's market hash and swarm belief.
{
  const m = recordedMarket();
  assert.equal(m.title, "What price will bitcoin hit in October 2026");
  assert.ok(m.oddsHashOk);
  assert.ok(m.done);
  assert.equal(m.forecasters.length, 3);
  assert.ok(m.forecasters.every((f) => f.cranked && f.counted));
  const v = await verifyMarket(m);
  assert.ok(v.ok);
  assert.deepEqual(v.colonies.map((c) => c.state), ["match", "match", "match"]);
  assert.equal(v.market.state, "match");
  assert.equal(v.market.actual, RECORDED.run.marketHash);
  assert.deepEqual(v.market.swarm, RECORDED.run.swarm);
}

// The hero's pace: 1× speed, 25 seconds for a forecast colony.
assert.equal(FORECAST_TICKS / HERO_TPS, 25);

// Scroll -> tick: starts at the seed, ends on the last tick, never runs
// backward, and holds on every checkpoint.
{
  const T = FORECAST_TICKS;
  assert.equal(storyTick(0, T), 0);
  assert.equal(storyTick(0.2, T), 0);
  assert.equal(storyTick(0.5, T), 100);
  assert.equal(storyTick(0.76, T), T);
  assert.equal(storyTick(1, T), T);
  assert.equal(storyTick(-1, T), 0);
  assert.equal(storyTick(2, T), T);
  let prev = 0;
  const seen = new Map();
  for (let i = 0; i <= 1000; i++) {
    const t = storyTick(i / 1000, T);
    assert.ok(Number.isInteger(t) && t >= prev && t <= T, `tick ${t} at ${i}`);
    seen.set(t, (seen.get(t) ?? 0) + 1);
    prev = t;
  }
  // Each checkpoint is held over a stretch of scroll, not passed in one step.
  for (const cp of [100, 200]) assert.ok(seen.get(cp) > 20, `hold at ${cp}: ${seen.get(cp)}`);
  assert.deepEqual([0, 1, 2, 3].map((s) => stepTick(s, T)), [0, 100, T, T]);
}

// Map size: whole pixels per cell.
assert.equal(heroCell({ vw: 1440, vh: 900 }), 13);   // 936 × 624
assert.equal(heroCell({ vw: 1280, vh: 800 }), 10);   // 720 × 480
assert.equal(heroCell({ vw: 1920, vh: 1080 }), 18);
assert.equal(heroCell({ vw: 390, vh: 844 }), 5);     // 360 × 240
assert.equal(heroCell({ vw: 768, vh: 1024 }), 10);
assert.equal(heroCell({ vw: 320, vh: 568 }), 4);

// The text summary.
{
  const base = { where: "Round 4", name: "Momentum", t: 300, ticks: 300, outcomes: ["Yes", "No"] };
  assert.equal(summaryText({ ...base, shares: [46.98, 53.02], swarm: [4377, 5623], check: "match" }),
    "Round 4, Momentum colony, tick 300 of 300. Trail share: Yes 47.0%, No 53.0%. Swarm belief across the colonies: Yes 43.8%, No 56.2%. The hash your browser computed matches the chain.");
  assert.equal(summaryText({ ...base, t: 0, shares: [0, 0], swarm: null, check: null }),
    "Round 4, Momentum colony, tick 0 of 300. No trail yet.");
  assert.match(summaryText({ ...base, shares: [50, 50], swarm: null, check: "mismatch" }), /differs from the chain's\.$/);
}

console.log("test_landing: ok");
