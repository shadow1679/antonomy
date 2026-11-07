// Offline tests for the Burn page's data layer: node web/test_burn.mjs
// Everything runs on canned contract JSON; no network. The determinism vector
// below comes from the Rust contract code itself: a scratch crate (path
// dependencies on token/ and sim/rust) calls
//   BurnRun::start(noon of day 20000, entropy [7; 32], "antonomy-oracle.testnet", &snapshot, 20000)
// on the snapshot below, advances it to the last tick and prints the run's
// seed, stake hash, burn_weights and result. The JS sim must reproduce all of it.
// V is from before the daily pot (plain stake richness, day < HANDICAP_FROM_DAY);
// V2 is the same snapshot on day 20760 from the current BurnRun, which
// handicaps the bigger pots (burn_richness).
import assert from "node:assert/strict";
import {
  burnAmount, potAmounts, potRules, HANDICAP_FROM_DAY, REWARD_MENU_BPS, fmtTokens, fmtTokens2, toTokens, isqrt, snapshotWeights, snapshotHash, snapshotWallets, snapshotTotals,
  clockTick, shownTick, dayRunAt, dayEndAt, dayStart, dayOf, dayDate, weightsFromSqrtYocto, parseBurnLogs,
  ONE, POT_MENU_BPS, DAY_MS, STAKING_MS, hexToBytes,
} from "./burn.mjs";
import { burnDay, drawnBurnDay, dayPhase, runProgress, dayProgress, rememberBurnDay, knownBurnDay, burnColony } from "./round.mjs";
import {
  loadBurn, burnView, runSpec, verifyRun, indexerBurns, burnRow, loadHistory, chainSkew, ensureBurnDay, treasuryId,
} from "./burnchain.mjs";
import { BURN_TICKS, trailShares } from "../sim/js/antosim.mjs";

// ---- result vector from Rust ----
const V = {
  day: 20000,
  seed: "70031d40c3c4aa1ad4e101c1c2d106b298d227f8c4a9bc873c3c72b6533e56a0",
  stake_hash: "cb9afd1adb41063bfe9677046a4659c7d9dd333f5ee571d5de8026f5efc9a065",
  entries: [
    ["alice.testnet", 0, 1, "25000000000000000000000000"],
    ["bob.testnet", 0, 1, "2333333333333333333333333"],
    ["bob.testnet", 0, 3, "64000000000000000000000000"],
    ["carol.testnet", 0, 4, "500000000000000000012345"],
    ["carol.testnet", 3, 0, "9000000000000000000000000"], // another colony: ignored by the Burn colony
  ],
  weights: [0, 6527, 0, 8000, 707],
  winner_option: 1,
  result_hash: "02c2b76fb10a172e0e394789e42fe3a20c166a9482874ffe5cfeaea344f35788",
  scores: [11993864, 16308216, 39270930, 41861751, 16348107],
  perm: [4, 3, 0, 2, 1],
};
const V2 = {
  day: 20760,
  seed: "17b8e3e1ffcd07211abcb56edf7a2bc5cf3746228c1faaf5ed88881579f1001a",
  winner_option: 3,
  result_hash: "ae5c6ac79478703c4ca257bb6dd097a9616dbad4c89b942bfb11736f5ed2ea85",
  scores: [24698345, 39065748, 38199105, 28345239, 15418050],
  perm: [0, 2, 3, 1, 4],
};
const doneRun = {
  day: V.day, t: BURN_TICKS, ticks: BURN_TICKS, seed: V.seed, stake_hash: V.stake_hash, done: true,
  winner_option: V.winner_option, result_hash: V.result_hash, scores: V.scores, perm: V.perm,
};
const snap = { day: V.day, hash: V.stake_hash, entries: V.entries, ok: true };

// ---- the daily pot, as token/src/burn.rs ----
assert.deepEqual(potAmounts(10_000n, 4), { pot: 200n, reward: 16n, burn: 184n });
assert.deepEqual(potAmounts(9_816n, 0), { pot: 9n, reward: 7n, burn: 2n });
assert.equal(burnAmount(10_000n, 4), 184n);
assert.equal(burnAmount(50n, 1), 0n);
assert.throws(() => potAmounts(1n, 5), RangeError);
assert.ok(Math.max(...POT_MENU_BPS) <= 200);
assert.ok(REWARD_MENU_BPS.every((r, i) => r <= POT_MENU_BPS[i]));
assert.equal(potRules(HANDICAP_FROM_DAY - 1), false);
assert.equal(potRules(HANDICAP_FROM_DAY), true);
assert.ok(V.day < HANDICAP_FROM_DAY && V2.day >= HANDICAP_FROM_DAY);
assert.equal(fmtTokens(1_234_567n * ONE + ONE / 2n), "1,234,567");
assert.equal(fmtTokens2(ONE / 2n), "0.5");
assert.equal(fmtTokens2(25n * ONE), "25");
assert.equal(toTokens(ONE / 4n), 0.25);

// ---- the day clock: half-day schedule, as token/src/day.rs ----
const D = 20_745; // 2026-10-19
assert.equal(DAY_MS, 86_400_000);
assert.equal(STAKING_MS, DAY_MS / 2);
assert.equal(dayRunAt(D), D * DAY_MS + 43_200_000);
assert.equal(dayEndAt(D) - dayRunAt(D), BURN_TICKS * 1000);
assert.equal(dayDate(D), "2026-10-19");
assert.equal(dayOf(dayStart(D) + 5), D);
const at = (h, m, s = 0) => dayStart(D) + ((h * 60 + m) * 60 + s) * 1000;
assert.equal(clockTick(D, at(11, 59, 59)), 0);
assert.equal(clockTick(D, at(12, 0)), 0);
assert.equal(clockTick(D, at(12, 0, 1)), 1);
assert.equal(clockTick(D, at(18, 0)), BURN_TICKS / 2);
assert.equal(clockTick(D, dayEndAt(D)), BURN_TICKS);
assert.equal(clockTick(D, dayEndAt(D) + DAY_MS), BURN_TICKS);

// The shown tick follows the clock, never the stored tick backwards, and says how far ahead it is.
{
  const run = { day: D, t: 600, ticks: BURN_TICKS };
  assert.deepEqual(shownTick(run, at(12, 20)), { chain: 600, clock: 1200, shown: 1200, lag: 600 });
  assert.deepEqual(shownTick(run, at(12, 20), { ahead: false }), { chain: 600, clock: 1200, shown: 600, lag: 600 });
  assert.equal(shownTick({ ...run, t: 5000 }, at(12, 1)).chain, 60, "the chain never runs ahead of the clock");
}

// ---- the round.mjs clock helpers the other pages import ----
const g = burnDay(D);
assert.equal(g.date, "2026-10-19");
assert.equal(g.endMs - g.startMs, DAY_MS);
assert.equal(g.runMs, at(12, 0));
assert.equal(dayPhase(g, at(11, 59, 59)), "staking");
assert.equal(dayPhase(g, at(12, 0)), "running");
assert.equal(runProgress(g, at(18, 0)) * BURN_TICKS, BURN_TICKS / 2);
assert.equal(dayProgress(g, at(12, 0)), 0.5);
assert.equal(drawnBurnDay(at(11, 59, 59)).day, D - 1);
assert.equal(drawnBurnDay(at(12, 0)).day, D);
assert.equal(drawnBurnDay(dayEndAt(D)).day, D);
// A day this browser has no chain data for has no seed, and never invents one.
assert.equal(g.known, false);
assert.equal(g.seed, null);
assert.equal(g.burn.seed, null);
assert.throws(() => g.burn.make(), /seed isn't known/);

// ---- stake snapshot maths vs the contract ----
assert.equal(isqrt(0n), 0n);
assert.equal(isqrt(99n), 9n);
assert.equal(isqrt(10n ** 48n), 10n ** 24n);
assert.equal(isqrt(10n ** 24n - 1n), 10n ** 12n - 1n);
assert.deepEqual(snapshotWeights(V.entries), V.weights);
assert.equal(snapshotHash(V.entries), V.stake_hash);
assert.notEqual(snapshotHash(V.entries.slice(1)), V.stake_hash);
assert.deepEqual(weightsFromSqrtYocto(["5000000000000000", "0"]), [5000000, 0]);
assert.deepEqual(snapshotTotals(V.entries).map(String), ["0", "27333333333333333333333333", "0", "64000000000000000000000000", "500000000000000000012345"]);
const wallets = snapshotWallets(V.entries);
assert.deepEqual(wallets.map((w) => w.id), ["alice.testnet", "bob.testnet", "carol.testnet"]);
assert.equal(wallets[2].stakes[3], 0, "other colonies' stakes are not Burn stakes");

// ---- determinism: the JS run reproduces the Rust run, bit for bit ----
const spec = runSpec(doneRun, snap);
assert.equal(spec.ticks, BURN_TICKS);
assert.deepEqual(spec.weights, V.weights);
const col = spec.make();
while (col.step());
const res = col.result();
assert.equal(res.hash, V.result_hash);
assert.equal(res.winner_option, V.winner_option);
assert.deepEqual(res.scores, V.scores);
assert.deepEqual(res.perm, V.perm);
assert.equal(trailShares(res).reduce((a, b) => a + b, 0), 10_000);

// verifyRun accepts it (reusing a finished colony or re-running), and notices any difference.
{
  const ok = await verifyRun(doneRun, snap, { col });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.mismatches, []);
  const rerun = await verifyRun(doneRun, snap, { chunk: 5000, yieldTo: async () => {} });
  assert.equal(rerun.ok, true);
  assert.equal(knownBurnDay(V.day).verified, true, "a verified day is kept with its inputs");
  const bad = await verifyRun({ ...doneRun, result_hash: "00".repeat(32) }, snap, { col });
  assert.equal(bad.ok, false);
  assert.ok(bad.mismatches.includes("result hash differs"));
  const wrong = await verifyRun({ ...doneRun, winner_option: 2 }, snap, { col });
  assert.ok(wrong.mismatches.includes("winner differs"));
  const badSnap = { ...snap, entries: V.entries.slice(0, 3) };
  await assert.rejects(() => verifyRun(doneRun, badSnap, {}), /does not match/);
  assert.equal((await verifyRun({ ...doneRun, done: false }, snap)).pending, true);
}

// Under the daily-pot rules the same snapshot runs handicapped, as the Rust BurnRun does.
{
  const run2 = { ...doneRun, day: V2.day, seed: V2.seed, winner_option: V2.winner_option, result_hash: V2.result_hash, scores: V2.scores, perm: V2.perm };
  const ok2 = await verifyRun(run2, { ...snap, day: V2.day }, {});
  assert.deepEqual(ok2.mismatches, []);
  assert.equal(ok2.hash, V2.result_hash);
}

// runSpec refuses a snapshot that isn't the one the run committed to.
assert.throws(() => runSpec({ ...doneRun, stake_hash: "11".repeat(32) }, snap), /does not match/);

// ---- known days: what the chain gave this browser lets Replay re-run it ----
rememberBurnDay({ day: V.day, seed: V.seed, stakeHash: V.stake_hash, entries: V.entries, winner: V.winner_option, hash: V.result_hash });
const kd = burnDay(V.day);
assert.equal(kd.known, true);
assert.equal(kd.winner, V.winner_option);
{
  const c = kd.burn.make();
  while (c.step());
  assert.equal(c.result().hash, V.result_hash);
  assert.ok(kd.burn.stakers.total > 0);
}
const two = burnColony(null);
assert.equal(two.stakers.total, 0);
assert.equal(burnColony(hexToBytes(V.seed), { weights: V.weights, stakeHash: hexToBytes(V.stake_hash) }).make().ticks, BURN_TICKS);

// ---- loadBurn and burnView on canned contract JSON ----
const noon = (d) => dayRunAt(d);
function chainOf({ day, phase, run = null, last = null, snaps = {}, treasury = "999800000000000000000000000000", me = null }) {
  return async (method, args = {}) => {
    switch (method) {
      case "burn_schedule": return { day, phase, run_at_ms: dayRunAt(day), end_at_ms: dayEndAt(day), drawn_day: phase === "running" ? day : day - 1 };
      case "burn_run": return run;
      case "last_burn_day": return last;
      case "stake_totals": return ["0", "27333333333333333333333333", "0", "64000000000000000000000000", "500000000000000000012345"];
      case "stake_weights": return ["0", "6527000000000", "0", "8000000000000", "707000000000"];
      case "stake_config": return { cap_per_wallet: "100000000000000000000000000", close_at_ms: 1, publish_at_ms: 2 };
      case "ft_balance_of": return args.account_id === treasuryId() ? treasury : (me?.balance ?? "0");
      case "ft_total_supply": return "1000000000000000000000000000000";
      case "daily_pot": return [0, 1, 2, 3, 4].map((i) => ({ pot_bps: POT_MENU_BPS[i], reward_bps: REWARD_MENU_BPS[i], burn_bps: POT_MENU_BPS[i] - REWARD_MENU_BPS[i], ...Object.fromEntries(Object.entries(potAmounts(BigInt(treasury), i)).filter(([k]) => k !== "pot").map(([k, v]) => [k, v.toString()])) }));
      case "reward_leaderboard": return [["alice.testnet", "5"], ["bob.testnet", "2"]];
      case "burn_lock": return { day: me?.lockDay ?? null, locked: !!me?.locked };
      case "burn_snapshot": if (snaps[args.day]) return { hash: snaps[args.day].hash, entries: snaps[args.day].entries }; throw new Error("no snapshot");
      case "has_claimed": return !!me;
      case "staked_by": return me?.staked ?? "0";
      case "stakes_of": return me?.stakes ?? [];
      case "rewards_earned": return "0";
      default: throw new Error(`unexpected ${method}`);
    }
  };
}
{
  // Before 12:00, nothing drawn: staking.
  const early = await loadBurn({ account: null, read: chainOf({ day: V.day, phase: "staking" }) });
  const v0 = burnView(early, dayStart(V.day) + 3600_000);
  assert.equal(v0.phase, "staking");
  assert.equal(v0.run, null);
  assert.equal(v0.prev, null);
  assert.equal(early.treasury, 999_800n * ONE);
  assert.deepEqual(early.weights, [0, 6527, 0, 8000, 707]);
  assert.equal(early.cap, 100n * ONE);
  assert.equal(early.me, null);
  assert.deepEqual(early.board, [["alice.testnet", 5n], ["bob.testnet", 2n]]);
  assert.deepEqual(early.pot.map((p) => [p.pot_bps, p.reward]), [0, 1, 2, 3, 4].map((i) => [POT_MENU_BPS[i], potAmounts(999_800n * ONE, i).reward]));

  // After 12:00, no crank yet: waiting, and no run, seed or map.
  const wait = await loadBurn({ account: null, read: chainOf({ day: V.day, phase: "running", snaps: { [V.day]: snap } }) });
  const v1 = burnView(wait, noon(V.day) + 5000);
  assert.equal(v1.phase, "waiting");
  assert.equal(v1.run, null);
  assert.equal(v1.tick, null);
  assert.equal(v1.snap.ok, true);

  // Running: the run is on chain, and the page runs ahead of its stored tick.
  const live = { ...doneRun, t: 600, done: false, winner_option: null, result_hash: null, scores: null, perm: null };
  const run = await loadBurn({ account: null, read: chainOf({ day: V.day, phase: "running", run: live, snaps: { [V.day]: snap } }) });
  const v2 = burnView(run, noon(V.day) + 1_200_000);
  assert.equal(v2.phase, "running");
  assert.deepEqual(v2.tick, { chain: 600, clock: 1200, shown: 1200, lag: 600 });
  assert.equal(runSpec(v2.run, v2.snap).make().ticks, BURN_TICKS);
  assert.ok(knownBurnDay(V.day).entries.length === 5, "the run's inputs are kept for later");

  // The next day's staking half, with yesterday's finished run not yet burned.
  const next = await loadBurn({ account: "me.testnet", read: chainOf({
    day: V.day + 1, phase: "staking", run: doneRun, last: V.day - 1, snaps: { [V.day]: snap },
    me: { balance: ONE.toString(), staked: (3n * ONE).toString(), stakes: [[0, 2, (3n * ONE).toString()], [1, 0, "5"]], lockDay: V.day + 1, locked: true },
  }) });
  const v3 = burnView(next, dayStart(V.day + 1) + 10_000);
  assert.equal(v3.phase, "staking");
  assert.equal(v3.prev.state, "done");
  assert.equal(v3.prev.snap.ok, true);
  assert.equal(next.me.stakes[2], 3n * ONE);
  assert.equal(next.me.stakes[0], 0n, "only Burn colony stakes count");
  assert.equal(next.me.balance, ONE);
  assert.deepEqual(next.me.lock, { day: V.day + 1, locked: true });
  // Once executed, nothing is left to settle.
  const burned = await loadBurn({ account: null, read: chainOf({ day: V.day + 1, phase: "staking", run: doneRun, last: V.day }) });
  assert.equal(burnView(burned, dayStart(V.day + 1) + 10).prev, null);
  // An unfinished run of an earlier day is reported as such.
  const stuck = await loadBurn({ account: null, read: chainOf({ day: V.day + 1, phase: "staking", run: { ...doneRun, done: false, t: 43000, result_hash: null, winner_option: null }, last: null, snaps: { [V.day]: snap } }) });
  assert.equal(burnView(stuck, dayStart(V.day + 1) + 10).prev.state, "unfinished");
  // A failing optional reader leaves a null and an error, not a crash; the schedule is required.
  const flaky = chainOf({ day: V.day, phase: "staking" });
  const part = await loadBurn({ account: null, read: async (m, a) => { if (m === "daily_pot" || m === "ft_balance_of") throw new Error("rpc down"); return flaky(m, a); } });
  assert.equal(part.pot, null);
  assert.equal(part.treasury, null);
  assert.equal(part.errors.length, 2);
  await assert.rejects(() => loadBurn({ account: null, read: async () => { throw new Error("down"); } }), /down/);
}

// A snapshot whose hash doesn't match is flagged, and its run isn't remembered as verified input.
{
  const forged = { hash: V.stake_hash, entries: V.entries.slice(0, 2) };
  const st = await loadBurn({ account: null, read: chainOf({ day: V.day, phase: "running", run: { ...doneRun, done: false, t: 5, result_hash: null }, snaps: { [V.day]: forged } }) });
  assert.equal(st.snaps[V.day].ok, false);
}

// ensureBurnDay reads the chain for a day that isn't known yet, once.
{
  const rd = chainOf({ day: 20_001, phase: "running", run: { ...doneRun, day: 20_001 }, snaps: { 20_001: { hash: V.stake_hash, entries: V.entries } } });
  const k = await ensureBurnDay(20_001, { read: rd });
  assert.equal(k.seed, V.seed);
  assert.equal(await ensureBurnDay(20_002, { read: rd }), null);
}

// chainSkew: the offset between the browser clock and the newest block.
{
  const fake = async () => ({ json: async () => ({ result: { header: { timestamp: String(BigInt(1_000_000 + 7000) * 1_000_000n) } } }) });
  const skew = await chainSkew({ fetchFn: fake, now: () => 1_000_000, rpcs: ["x"] });
  assert.equal(skew, 7000);
  assert.equal(await chainSkew({ fetchFn: async () => { throw new Error("down"); }, rpcs: ["x", "y"] }), 0);
}

// ---- contract events ----
{
  const p = parseBurnLogs([
    "EVENT burn_seed day=20000 seed=ab stakes=cd",
    "EVENT burn_crank day=20000 t=10 steps=10 someone.testnet",
    "EVENT burn_run_done day=20000 winner=1 hash=ee",
    "EVENT burn day=20000 index=1 amount=2499500000000000000000000 stakes=cd",
    "EVENT reward day=20000 a.testnet amount=1",
    "EVENT burn day=x index=1 amount=1 stakes=cd",
  ]);
  assert.deepEqual(p.burn, { day: 20000, index: 1, amount: 2499500000000000000000000n, reward: 0n, stakes: "cd" });
  assert.deepEqual(parseBurnLogs(["EVENT burn day=20760 index=4 amount=184 reward=16 stakes=cd"]).burn,
    { day: 20760, index: 4, amount: 184n, reward: 16n, stakes: "cd" });
  assert.deepEqual(p.done, { day: 20000, winner: 1, hash: "ee" });
  assert.deepEqual(p.seed, { day: 20000, seed: "ab", stakes: "cd" });
  assert.deepEqual(parseBurnLogs(undefined), { burn: null, done: null, seed: null });
}

// ---- history: the indexer's execute_burn list, then the contract at each block ----
{
  const txn = (day, tx, height, status = true) => ({
    transaction_hash: tx, predecessor_account_id: "keeper.testnet", receiver_account_id: "antonomy-oracle.testnet",
    receipt_block: { block_height: height }, block_timestamp: String(BigInt(dayEndAt(day) + 60_000) * 1_000_000n),
    actions: [{ action: "FUNCTION_CALL", method: "execute_burn", args: JSON.stringify({ day }) }], outcomes: { status },
  });
  const fetchFn = async (url) => {
    assert.ok(url.includes("/account/antonomy-oracle.testnet/txns?method=execute_burn"));
    return { ok: true, json: async () => ({ txns: [txn(V.day, "TX20000", 5000), txn(V.day, "TX20000b", 5001, false), txn(V.day - 1, "TX19999", 4000)] }) };
  };
  const list = await indexerBurns({ fetchFn });
  assert.deepEqual(list.map((x) => [x.day, x.tx, x.height]), [[V.day, "TX20000", 5000], [V.day - 1, "TX19999", 4000]]);
  assert.equal(list[0].ms, dayEndAt(V.day) + 60_000);

  // Before the burn (block 4999) and at its block (5000): the supply fell by
  // the burn, the treasury by the burn and the reward.
  const T0 = 999_800n * ONE, S0 = 1_000_000n * ONE, BURNT = 1_000n * ONE, PAID = 80n * ONE;
  const calls = [];
  const readAt = async (h, method, args) => {
    calls.push([h, method]);
    if (h !== 4999 && h !== 5000) throw new Error("archive has no such block");
    if (method === "burn_run") return doneRun;
    if (method === "burn_snapshot") return { hash: V.stake_hash, entries: V.entries };
    if (method === "ft_total_supply") return String(h === 4999 ? S0 : S0 - BURNT);
    return String(h === 4999 ? T0 : T0 - BURNT - PAID); // ft_balance_of treasury
  };
  const row = await burnRow(list[0], { read: readAt });
  assert.equal(row.detail, true);
  assert.equal(row.index, V.winner_option);
  assert.equal(row.before, T0);
  assert.equal(row.burned, BURNT);
  assert.equal(row.reward, PAID);
  assert.equal(row.after, T0 - BURNT - PAID);
  assert.equal(row.hash, V.result_hash);
  assert.equal(row.entries.length, 5);
  assert.ok(calls.every(([h, m]) => h === 4999 || (h === 5000 && /^ft_/.test(m))), "reads the run before the burn and the amounts after it");
  // The row's inputs re-run to the chain's hash.
  const again = await verifyRun({ ...doneRun, seed: row.seed }, { hash: row.stakeHash, entries: row.entries }, {});
  assert.equal(again.ok, true);
  // An archive that can't answer degrades to the indexer's facts, not an invented row.
  const bad = await burnRow(list[1], { read: readAt });
  assert.equal(bad.detail, false);
  assert.equal(bad.index, undefined);
  assert.equal(bad.day, V.day - 1);
  // loadHistory: indexer down -> empty list and a flag; never fixtures.
  const down = await loadHistory({ fetchFn: async () => { throw new Error("offline"); } });
  assert.deepEqual([down.rows, down.indexer], [[], false]);
  const full = await loadHistory({ fetchFn, read: readAt });
  assert.equal(full.indexer, true);
  assert.equal(full.rows.length, 2);
}

console.log("burn: ok");
