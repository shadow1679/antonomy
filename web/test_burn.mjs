// Offline tests for the burn day clock and burn history: node web/test_burn.mjs
import assert from "node:assert/strict";
import { burnHistory, burnAmount, fmtTokens, ONE, GENESIS_DAY, TREASURY_START, BURN_MENU_BPS } from "./burn.mjs";
import {
  burnDay, demoBurnDay, drawnBurnDay, dayPhase, runProgress, dayProgress, stakesAt, daySeed,
  DAY_MS, STAKING_MS, BURN_WALLETS, roundColonies,
} from "./round.mjs";
import { toHex, seedFromInt, BURN_TICKS } from "../sim/js/antosim.mjs";

const finish = (col) => { while (col.t < col.ticks) col.step(); return col.result(); };

// Amounts match token/src/burn.rs: floor(treasury × bps / 10000), capped menu.
assert.equal(burnAmount(10_000n, 4), 200n);
assert.equal(burnAmount(9_800n, 0), 9n);
assert.equal(burnAmount(50n, 1), 0n);
assert.throws(() => burnAmount(1n, 5), RangeError);
assert.ok(Math.max(...BURN_MENU_BPS) <= 200);
assert.equal(fmtTokens(1_234_567n * ONE + ONE / 2n), "1,234,567");

// A burn day is one UTC day; the colony is final at its end.
assert.equal(GENESIS_DAY, 20745);
const g = burnDay(GENESIS_DAY);
assert.equal(g.date, "2026-10-19");
assert.equal(g.startMs, Date.UTC(2026, 9, 19));
assert.equal(g.endMs - g.startMs, DAY_MS);
assert.equal(demoBurnDay(g.startMs).day, GENESIS_DAY);
assert.equal(demoBurnDay(g.endMs - 1).day, GENESIS_DAY);
assert.equal(demoBurnDay(g.endMs).day, GENESIS_DAY + 1);
const at = (h, m, s = 0) => g.startMs + ((h * 60 + m) * 60 + s) * 1000;
// Staking 00:00 to 12:00 UTC, then the run.
assert.equal(g.runMs, at(12, 0));
assert.equal(STAKING_MS, DAY_MS / 2);
assert.equal(dayPhase(g, g.startMs), "staking");
assert.equal(dayPhase(g, at(11, 59, 59)), "staking");
assert.equal(dayPhase(g, at(12, 0)), "running");
assert.equal(dayPhase(g, g.endMs - 1), "running");
// The run's ticks fill 12:00 to 24:00 UTC, one a second.
const tick = (now) => runProgress(g, now) * g.burn.ticks;
assert.equal(g.burn.ticks, BURN_TICKS);
assert.equal(g.burn.ticks, (DAY_MS - STAKING_MS) / 1000);
assert.equal(tick(g.startMs), 0);
assert.equal(tick(at(11, 59, 59)), 0);
assert.equal(tick(at(12, 0)), 0);
assert.equal(tick(at(12, 0, 1)), 1);
assert.equal(tick(at(18, 0)), BURN_TICKS / 2);
assert.equal(tick(at(23, 59, 59)), BURN_TICKS - 1);
assert.equal(tick(g.endMs), BURN_TICKS);
assert.equal(tick(g.endMs + DAY_MS), BURN_TICKS);
assert.equal(dayProgress(g, at(12, 0)), 0.5);
// A day's seed counts as drawn from its 12:00 UTC, not before.
assert.equal(drawnBurnDay(at(11, 59, 59)).day, GENESIS_DAY - 1);
assert.equal(drawnBurnDay(at(12, 0)).day, GENESIS_DAY);
assert.equal(drawnBurnDay(g.endMs - 1).day, GENESIS_DAY);
assert.equal(drawnBurnDay(g.endMs).day, GENESIS_DAY);
// Sugar piles up while staking is open, and every wallet is in at the close.
assert.equal(stakesAt(g, g.startMs).length, 0);
for (let m = 1; m < 12 * 60; m++) assert.ok(stakesAt(g, at(0, m - 1)).length <= stakesAt(g, at(0, m)).length);
assert.ok(BURN_WALLETS.every((w) => w.at > 0 && w.at < STAKING_MS / 60_000));
assert.deepEqual(stakesAt(g, g.runMs), BURN_WALLETS);
// Day seeds differ from round seeds and from each other.
assert.notEqual(toHex(daySeed(5)), toHex(seedFromInt(5)));
assert.notEqual(toHex(daySeed(5)), toHex(daySeed(6)));
// Rounds carry only forecasters now.
assert.ok(roundColonies(seedFromInt(1)).all.every((s) => s.key !== "burn"));

// A clone mid-run finishes on the same hash (the replay seeks from clones).
{
  const col = burnDay(GENESIS_DAY).burn.make();
  for (let i = 0; i < 5000; i++) col.step();
  const copy = col.clone();
  for (let i = 0; i < 3000; i++) { col.step(); copy.step(); }
  assert.deepEqual(copy.scores(), col.scores());
  assert.deepEqual(copy.last, col.last);
}

// The live leader reads standing(): the scores a run stopped at that tick
// would end with, on and off the 100-tick checkpoints.
{
  const col = burnDay(GENESIS_DAY).burn.make();
  for (const t of [1, 99, 100, 101, 250]) {
    while (col.t < t - 1) col.step();
    const stop = col.clone();
    stop.ticks = t; // its last step is a final tick, so it takes the checkpoint
    stop.step();
    col.step();
    assert.deepEqual(col.standing(), stop.result().scores, `tick ${t}`);
  }
}

// History: one row per finished day, each burning from the day before's
// treasury. A day's run is 43,200 ticks, so keep N small.
const N = 3;
const h = await burnHistory(GENESIS_DAY + N);
assert.equal(h.rows.length, N);
assert.equal(h.rows[0].before, TREASURY_START);
for (const [i, r] of h.rows.entries()) {
  assert.equal(r.day, GENESIS_DAY + i);
  assert.equal(r.burned, burnAmount(r.before, r.index));
  assert.equal(r.after, r.before - r.burned);
  assert.ok(r.burned * 50n <= r.before, "never more than 2%");
  if (i) assert.equal(r.before, h.rows[i - 1].after);
  // The row's hash is the Burn colony's result hash for that day.
  const res = finish(burnDay(r.day).burn.make());
  assert.equal(r.hash, res.hash);
  assert.equal(r.index, res.winner_option);
  assert.equal(r.shares.reduce((a, b) => a + b, 0), 10_000);
}
assert.equal(h.treasury, h.rows[N - 1].after);
assert.equal(h.burned, TREASURY_START - h.treasury);

// Deterministic, and a shorter history is a prefix of a longer one.
assert.deepEqual(await burnHistory(GENESIS_DAY + N), h);
assert.deepEqual((await burnHistory(GENESIS_DAY + 2)).rows, h.rows.slice(0, 2));
assert.equal((await burnHistory(GENESIS_DAY)).rows.length, 0);
assert.equal((await burnHistory(GENESIS_DAY - 3)).treasury, TREASURY_START);

console.log("burn history: ok");
