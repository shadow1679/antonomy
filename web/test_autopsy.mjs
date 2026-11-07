// Offline tests for ant autopsy: node web/test_autopsy.mjs
import assert from "node:assert/strict";
import { antLives, tripAt, deliveredBy, notableAnts, TripTracker } from "./autopsy.mjs";
import { roundColonies, burnColony } from "./round.mjs";
import { seedFromInt } from "../sim/js/antosim.mjs";

const finish = (col) => { while (col.t < col.ticks) col.step(); return col.result(); };

// The Burn colony and one forecaster.
for (const spec of [burnColony(seedFromInt(11)), roundColonies(seedFromInt(11)).all[0]]) {
  const t0 = performance.now();
  const lives = antLives(spec.make);
  const ms = Math.round(performance.now() - t0);
  assert.equal(lives.length, spec.ants);
  assert.deepEqual(antLives(spec.make), lives, "same seed, same lives");

  // Replay the colony and check every ant, every tick, against the log.
  const col = spec.make();
  let trips = 0;
  while (col.step()) {
    for (let a = 0; a < col.ants; a++) {
      const k = tripAt(lives[a], col.t);
      assert.equal(k >= 0, col.returning[a] === 1, `ant ${a} tick ${col.t}`);
      if (k >= 0 && lives[a][k].pick === col.t) assert.equal(col.strength[a], lives[a][k].deposit);
    }
  }
  for (const life of lives) {
    let prevHome = 0;
    for (const x of life) {
      assert.ok(x.source >= 0 && x.opt === col.perm.indexOf(x.source));
      assert.ok(x.pick > prevHome && (x.home === null || x.home > x.pick));
      assert.ok(x.deposit > 0);
      prevHome = x.home ?? Infinity;
      trips++;
    }
  }
  assert.ok(trips > 0, "ants found food");

  // The log is view data: the run it came from still hashes the same.
  assert.equal(finish(spec.make()).hash, col.result().hash);

  // deliveredBy counts finished trips only.
  const busiest = lives.reduce((b, l, a) => (l.length > lives[b].length ? a : b), 0);
  const done = lives[busiest].filter((x) => x.home !== null);
  assert.equal(deliveredBy(lives[busiest], spec.ticks, spec.labels.length).reduce((s, v) => s + v, 0), done.length);
  assert.equal(deliveredBy(lives[busiest], 0, spec.labels.length).reduce((s, v) => s + v, 0), 0);
  // Notable ants point at real ants that fit their description.
  const picks = notableAnts(lives);
  const homeOf = (a) => lives[a].filter((x) => x.home !== null);
  for (const p of picks) {
    assert.ok(p.ant >= 0 && p.ant < spec.ants);
    assert.equal(p.trips, homeOf(p.ant).length);
  }
  const busy = picks.find((p) => p.key === "busiest");
  assert.ok(lives.every((_, a) => homeOf(a).length <= busy.trips));
  const loyal = picks.find((p) => p.key === "loyal");
  if (loyal) assert.ok(homeOf(loyal.ant).every((x) => x.opt === loyal.opt));
  const lost = picks.find((p) => p.key === "wanderer");
  if (lost) assert.equal(lives[lost.ant].length, 0);

  // A tracker watching a live colony halfway logs the same trips so far.
  const live = spec.make(), tr = new TripTracker(live), half = spec.ticks >> 1;
  while (live.t < half) { live.step(); tr.observe(live); }
  tr.lives.forEach((l, a) => assert.deepEqual(l.map((x) => x.pick), lives[a].filter((x) => x.pick <= half).map((x) => x.pick)));
  console.log(`${spec.key}: ${spec.ants} ants, ${trips} trips, logged in ${ms} ms, ${picks.length} notable ants`);
}
console.log("autopsy ok");
