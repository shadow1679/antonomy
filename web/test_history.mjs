// Offline tests for the history walk (histchain.mjs): node web/test_history.mjs
// A canned chain: blocks every 600 ms (a few heights skipped), rounds and
// burn days laid out in time, and views answered as of any height.
import assert from "node:assert/strict";
import { RoundWalk, PotWalk, Clock, fileRequests, byDay, roundRow, memCache, beliefOf, requestMarket, pageOf } from "./histchain.mjs";
import { potAmounts, snapshotHash, dayEndAt, dayRunAt } from "./burn.mjs";
import { cannedRound, REQUEST_0 } from "./test_chain_fixture.mjs";

const T0 = Date.UTC(2026, 9, 27, 0, 0, 0);     // height 0
const BMS = 600;
const SKIP = new Set([1000, 1001, 5000]);       // heights with no block
const HEAD = Math.floor((Date.UTC(2026, 9, 30, 10, 0, 0) - T0) / BMS);
const msOf = (h) => T0 + h * BMS;
const heightOf = (ms) => Math.floor((ms - T0) / BMS);
let reads = 0;
const block = async (h) => {
  reads++;
  if (h === "final") return { height: HEAD, ms: msOf(HEAD) };
  if (h > HEAD) throw new Error("UNKNOWN_BLOCK");
  while (SKIP.has(h)) h--;
  return { height: h, ms: msOf(h) };
};

// ---- rounds ----
// Round 0 starts at the deploy (no contract before it); each lasts 40
// minutes. Round 3 is skipped (no quorum), round 5 is abandoned (two colonies
// ran), round 6 finishes 10 s before round 7 starts.
const STAKE_MS = 1_200_000, GAP_MS = 300_000, LEN = 40 * 60_000;
const DEPLOY = Date.UTC(2026, 9, 30, 4, 0, 0);
const C = 8;
const startOf = (id) => DEPLOY + id * LEN;
const runOf = (id, cranked = 3) => cannedRound(id, { cranked });
function statusAt(id, ms) {
  const base = { round: id, close_at_ms: startOf(id) + STAKE_MS, publish_at_ms: startOf(id) + STAKE_MS + GAP_MS, drand_round: 1 };
  if (id === 3) return { ...base, phase: "skipped", markets: null, run: null };
  if (id === C) return { ...base, phase: "posting", markets: null, run: null };
  const c = runOf(id, id === 5 ? 2 : 3);
  if (id === 6 && ms < startOf(7) - 10_000) {
    const half = runOf(6, 2);
    return { ...base, phase: "running", markets: [half.mv], run: half.run };
  }
  return { ...base, phase: c.run.done ? "done" : "running", markets: [c.mv], run: c.run };
}
const roundAtMs = (ms) => (ms < DEPLOY ? null : Math.min(C, Math.floor((ms - DEPLOY) / LEN)));
function lastRoundAt(ms) {
  for (let id = roundAtMs(ms) - 1; id >= 0; id--) {
    if (id === 3 || id === 5) continue; // only finished rounds move into last_round
    const c = runOf(id);
    return { markets: [c.mv], run: c.run };
  }
  return null;
}

// ---- pots ----
// Days 20753 to 20755 ran. 20754 was lost (no run), so last_burn_day went
// 20753 -> 20755. Each pot is paid at 00:01 the next day; each day's run
// stays in burn_run until 12:05 the day after.
const TREASURY = 50_000n * 10n ** 24n;
const entries = (day) => [["a.testnet", 0, day % 5, "4000000000000000000000000"], ["b.testnet", 0, 2, "9000000000000000000000000"]];
const burnRunOf = (day) => ({ day, t: 43200, ticks: 43200, done: true, seed: "ab".repeat(32), stake_hash: snapshotHash(entries(day)), winner_option: day % 5, result_hash: "cd".repeat(32), scores: [1, 2, 3, 4, 5], perm: [0, 1, 2, 3, 4] });
const PAID = [[20753, dayEndAt(20753) + 60_000], [20755, dayEndAt(20755) + 60_000]];
const lbdAt = (ms) => PAID.filter(([, at]) => at <= ms).map(([d]) => d).at(-1) ?? null;
function burnRunAt(ms) {
  for (const d of [20755, 20753]) if (ms >= dayRunAt(d) + 5 * 60_000) return burnRunOf(d);
  return null;
}

function view(ms, method, args) {
  if (ms < Date.UTC(2026, 9, 27, 6)) throw Object.assign(new Error("UNKNOWN_ACCOUNT"), { gone: true }); // deployed 06:00 on day 20753
  switch (method) {
    case "round_status": { const id = roundAtMs(ms); if (id === null) throw Object.assign(new Error("UNKNOWN_ACCOUNT"), { gone: true }); return statusAt(id, ms); }
    case "round_config": return { stake_ms: STAKE_MS, gap_ms: GAP_MS };
    case "last_round": return lastRoundAt(ms);
    case "last_burn_day": return lbdAt(ms);
    case "burn_run": return burnRunAt(ms);
    case "ft_balance_of": return String(TREASURY);
    case "burn_snapshot": {
      const paidAt = PAID.find(([d]) => d === args.day)?.[1];
      if (ms < dayRunAt(args.day) || (paidAt && ms >= paidAt)) throw new Error("no snapshot");
      return { hash: snapshotHash(entries(args.day)), entries: entries(args.day) };
    }
  }
  throw new Error(`unknown view ${method}`);
}
const read = async (h, method, args = {}) => {
  reads++;
  if (SKIP.has(h)) throw Object.assign(new Error("UNKNOWN_BLOCK"), { missing: true });
  return view(msOf(h), method, args);
};
const call = async (method, args = {}) => view(msOf(HEAD), method, args);

// The clock finds a block near a time from any anchor, in a few reads.
{
  const clock = new Clock(block);
  await clock.head();
  reads = 0;
  const t = Date.UTC(2026, 9, 29, 7, 30);
  const b = await clock.near(t, 2000);
  assert.ok(Math.abs(b.ms - t) <= 2000);
  assert.ok(reads <= 3, `clock took ${reads} reads`);
  // A skipped height gives the block below it.
  assert.equal((await block(1001)).height, 999);
}

// The walk lists every round of this deployment, newest first, and stops at round 0.
{
  const cache = memCache();
  const w = new RoundWalk({ call, read, block, cache });
  reads = 0;
  const seen = [];
  await w.more(4, (r) => seen.push(r.id));
  assert.deepEqual(seen, [8, 7, 6, 5]);
  assert.equal(w.rows[0].live, true);
  assert.equal(w.rows[0].state, "posting");
  assert.equal(w.rows[0].endMs, null);
  await w.more(20);
  assert.equal(w.done, true);
  assert.deepEqual(w.rows.map((r) => r.id), [8, 7, 6, 5, 4, 3, 2, 1, 0]);
  for (const r of w.rows) assert.equal(r.startMs, startOf(r.id), `round ${r.id} start`);
  for (const r of w.rows.slice(1)) assert.equal(r.endMs, startOf(r.id + 1), `round ${r.id} end`);
  const by = Object.fromEntries(w.rows.map((r) => [r.id, r]));
  assert.equal(by[3].state, "skipped");
  assert.equal(by[3].total, 0);
  assert.equal(by[5].state, "abandoned");
  assert.equal(by[5].cranked, 2);
  // Round 6 looked unfinished 30 s before its end; last_round one round later has it done.
  assert.equal(by[6].state, "done");
  assert.equal(by[6].cranked, 3);
  assert.equal(by[6].status.run.markets[0].market_hash, runOf(6).run.markets[0].market_hash);
  assert.equal(by[2].seed, runOf(2).run.seed);
  assert.ok(reads <= 9 * 4, `walk took ${reads} reads`);

  // A second walk on the same cache reads nothing from the archive.
  reads = 0;
  const w2 = new RoundWalk({ call, read, block, cache });
  await w2.more(20);
  assert.deepEqual(w2.rows.map((r) => r.id), [8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.equal(reads, 1, "only the head block");

  // find and findAt walk only as far as they must.
  const w3 = new RoundWalk({ call, read, block, cache: memCache() });
  assert.equal((await w3.find(6)).id, 6);
  assert.deepEqual(w3.rows.map((r) => r.id), [8, 7, 6]);
  assert.equal((await w3.findAt(startOf(4) + 1000)).id, 4);
  assert.equal(await w3.find(42), null);
}

// Round ids that restart (a redeploy with `new`) end the walk.
{
  const odd = async (h, m, a) => (m === "round_status" && msOf(h) < startOf(2) ? { ...view(msOf(h), m, a), round: 17 } : read(h, m, a));
  const w = new RoundWalk({ call, read: odd, block, cache: memCache() });
  await w.more(20);
  assert.deepEqual(w.rows.map((r) => r.id), [8, 7, 6, 5, 4, 3, 2]);
  assert.equal(w.done, true);
}

// Requests go under the round open when they were made; older ones wait.
{
  const rows = [8, 7, 6].map((id) => roundRow({ id, status: statusAt(id, startOf(id + 1) - 1), startMs: startOf(id), endMs: id === 8 ? null : startOf(id + 1), live: id === 8 }));
  const q = (id, ms) => ({ id, created_at_ms: ms });
  fileRequests(rows, [q(0, startOf(2)), q(1, startOf(6) + 5), q(2, startOf(7)), q(3, startOf(7) + 60_000), q(4, startOf(8) + 10 ** 7)]);
  assert.deepEqual(rows.map((r) => r.requests.map((x) => x.id)), [[4], [3, 2], [1]]);
  // Grouped by UTC day, in the order given.
  assert.deepEqual(byDay(rows, (r) => r.startMs).map((g) => [g.date, g.rows.length]), [["2026-10-30", 3]]);
  assert.deepEqual(byDay([{ ms: Date.UTC(2026, 9, 30, 1) }, { ms: Date.UTC(2026, 9, 29, 23) }], (r) => r.ms).map((g) => g.date), ["2026-10-30", "2026-10-29"]);
}

// A row's markets carry their odds and the chain's swarm belief; a market's
// result leads on its biggest share, in whole points.
{
  const c = runOf(2);
  const row = roundRow({ id: 2, status: { round: 2, phase: "done", markets: [c.mv], run: c.run }, startMs: 0, endMs: 1 });
  const m = row.markets[0];
  assert.deepEqual(m.odds, c.mv.odds);
  assert.deepEqual(m.swarm, c.run.markets[0].swarm);
  assert.equal(m.cranked, 3);
  const b = beliefOf(m);
  assert.equal(b.lead, m.swarm.indexOf(Math.max(...m.swarm)));
  assert.equal(b.gap, b.swarm[b.lead] - b.market[b.lead]);
  assert.equal(beliefOf({ ...m, swarm: null }), null);
  // Round 5 ran two colonies: no result.
  const half = runOf(5, 2);
  const r5 = roundRow({ id: 5, status: { round: 5, phase: "running", markets: [half.mv], run: half.run }, startMs: 0, endMs: 1 });
  assert.equal(r5.markets[0].cranked, 2);
  assert.equal(beliefOf(r5.markets[0]), null);
  // A request reads the same way.
  const rq = beliefOf(requestMarket(REQUEST_0));
  assert.equal(rq.lead, 0);
  assert.deepEqual(rq.swarm, [34, 15, 27, 17, 7]);
  assert.equal(rq.gap, 34 - 44);
}

// Pages: newest first; while the walk can read more, one page past the rows read exists.
{
  assert.deepEqual(pageOf(12, 0, 5), { page: 0, from: 0, to: 5, newer: false, older: true, short: false });
  assert.deepEqual(pageOf(12, 2, 5), { page: 2, from: 10, to: 12, newer: true, older: false, short: false });
  assert.equal(pageOf(12, 9, 5).page, 2);
  assert.deepEqual(pageOf(10, 2, 5, true), { page: 2, from: 10, to: 10, newer: true, older: false, short: true });
  assert.equal(pageOf(10, 1, 5, true).older, true);
  assert.equal(pageOf(7, 1, 5, true).older, false, "fill this page before the next");
  assert.equal(pageOf(7, 1, 5, true).short, true);
  assert.deepEqual(pageOf(0, 3, 5, true), { page: 0, from: 0, to: 0, newer: false, older: false, short: true });
}

// Pots: the newest paid day, a lost day the counter jumped over, then the first day.
{
  const cache = memCache();
  const w = new PotWalk({ call, read, block, cache });
  reads = 0;
  await w.more(10);
  assert.equal(w.done, true);
  assert.deepEqual(w.rows.map((r) => [r.day, r.state]), [[20755, "paid"], [20754, "lost"], [20753, "paid"]]);
  const r = w.rows[0];
  assert.equal(r.index, 20755 % 5);
  const p = potAmounts(TREASURY, r.index);
  assert.equal(r.burned, p.burn);
  assert.equal(r.reward, p.reward);
  assert.equal(r.after, TREASURY - p.burn - p.reward);
  assert.deepEqual(r.entries, entries(20755), "the stake snapshot from before the payout");
  assert.equal(r.seed, burnRunOf(20755).seed);
  // Day 20753 ran under the first rules: the whole pot burned.
  assert.equal(w.rows[2].reward, 0n);
  assert.equal(w.rows[2].burned, potAmounts(TREASURY, 20753 % 5).pot);
  assert.ok(reads <= 20, `pot walk took ${reads} reads`);
  // Cached: a second walk reads only the head.
  reads = 0;
  const w2 = new PotWalk({ call, read, block, cache });
  await w2.more(10);
  assert.deepEqual(w2.rows.map((x) => x.state), ["paid", "lost", "paid"]);
  assert.equal(reads, 1);
  assert.equal(typeof w2.rows[0].burned, "bigint");
  // find stops at the day asked for.
  const w3 = new PotWalk({ call, read, block, cache: memCache() });
  assert.equal((await w3.find(20755)).state, "paid");
  assert.deepEqual(w3.rows.map((x) => x.day), [20755, 20754], "and the lost day it jumped over");
}

// Today's run, not paid yet, comes first as a live row.
{
  const now = dayRunAt(20756) + 3600_000;
  const H = heightOf(now);
  const callNow = async (method, args = {}) => (method === "burn_run" ? { ...burnRunOf(20756), done: false, t: 6000, result_hash: null, winner_option: null } : view(msOf(H), method, args));
  const blockNow = async (h) => (h === "final" ? { height: H, ms: msOf(H) } : block(h));
  const w = new PotWalk({ call: callNow, read, block: blockNow, cache: memCache() });
  await w.more(1);
  assert.deepEqual([w.rows[0].day, w.rows[0].state, w.rows[0].live], [20756, "running", true]);
}

console.log("history ok");
