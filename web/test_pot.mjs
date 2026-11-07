// Offline tests for the Daily Pot page's pure layer (web/pot.mjs): node web/test_pot.mjs
import assert from "node:assert/strict";
import { BURN_TICKS } from "../sim/js/antosim.mjs";
import { ONE, dayRunAt, dayEndAt, dayStart, potAmounts } from "./burn.mjs";
import { burnView } from "./burnchain.mjs";
import * as P from "./pot.mjs";

const D = 20756; // 2026-10-30
const T = 812_400n * ONE;
const tok = (x) => BigInt(x) * ONE;
const st0 = { lastBurnDay: D - 1, run: { day: D - 1, done: true, t: BURN_TICKS, ticks: BURN_TICKS, winner_option: 2, seed: "aa".repeat(32), stake_hash: "bb".repeat(32), result_hash: "cc".repeat(32) }, snaps: {}, treasury: T, paused: false };
const stage = (st, now) => P.potStage(st, burnView(st, now), now);

// ---- drand: the contract's round_after ----
assert.equal(P.roundAfter(1_692_803_367_000), 2);
assert.equal(P.roundAfter(1_692_803_367_000 + 2_999), 2);
assert.equal(P.roundAfter(1_692_803_367_000 + 3_000), 3);
assert.equal(P.dayDrand(D), Math.floor((dayRunAt(D) - 1_692_803_367_000) / 3000) + 2);

// ---- the stage of the day ----
{
  const s = stage(st0, dayStart(D) + 3600_000);
  assert.equal(s.stage, "staking");
  assert.equal(s.focus, D);
  assert.equal(s.last, "paid");
  assert.deepEqual(P.stepStates(s), ["now", "next", "next", "next", "next"]);
  assert.match(P.clockOf(s).value, /^1[01]:/);
  assert.equal(stage(st0, dayRunAt(D) - 10 * 60_000).stage, "closing");
  // Yesterday not paid and not held: skipped.
  assert.equal(stage({ ...st0, lastBurnDay: D - 2, run: { ...st0.run, day: D - 2 } }, dayStart(D) + 1000).last, "skipped");
}
{
  // After 12:00 with no seed: waiting, stalled after 90 minutes.
  const w = stage(st0, dayRunAt(D) + 60_000);
  assert.equal(w.stage, "waiting");
  assert.equal(w.stalled, false);
  assert.deepEqual(P.stepStates(w), ["past", "now", "next", "next", "next"]);
  const late = stage(st0, dayRunAt(D) + P.SEED_LATE_MS + 1);
  assert.equal(late.stalled, true);
  assert.deepEqual(P.stepStates(late), ["past", "stalled", "next", "next", "next"]);
  assert.equal(P.bannerOf(late).crank, true);
}
{
  // Running: stalled once the chain is more than 5,400 ticks behind the clock.
  const run = { day: D, done: false, t: 20_000, ticks: BURN_TICKS, seed: "aa".repeat(32), stake_hash: "bb".repeat(32) };
  const st = { ...st0, run };
  const ok = stage(st, dayRunAt(D) + 24_000_000);
  assert.equal(ok.stage, "running");
  assert.equal(ok.lag, 4_000);
  assert.equal(ok.stalled, false);
  const bad = stage(st, dayRunAt(D) + 26_000_000);
  assert.equal(bad.lag, 6_000);
  assert.equal(bad.stalled, true);
  assert.match(P.bannerOf(bad).title, /tick 20,000/);
  assert.match(P.stepsHTML(ok), /tick 24,000 \/ 43,200 · chain at 20,000/);
}
{
  // After 24:00: the day's run done and not paid is due, then overdue.
  const st = { ...st0, lastBurnDay: D - 1, run: { ...st0.run, day: D } };
  const due = stage(st, dayEndAt(D) + 60_000);
  assert.equal(due.stage, "due");
  assert.equal(due.focus, D);
  assert.equal(due.picked, 2);
  assert.deepEqual(P.stepStates(due), ["past", "past", "past", "past", "now"]);
  assert.equal(stage(st, dayEndAt(D) + P.OVERDUE_MS + 1).stage, "overdue");
  // Not at its last tick: finishing.
  const fin = stage({ ...st, run: { ...st.run, done: false, t: 40_000, winner_option: null, result_hash: null } }, dayEndAt(D) + 60_000);
  assert.equal(fin.stage, "finishing");
  assert.equal(fin.lag, BURN_TICKS - 40_000);
  // Paused overrides the clock and the banner.
  const ps = stage({ ...st, paused: true }, dayEndAt(D) + 60_000);
  assert.equal(P.clockOf(ps).label, "Payout due"); // the banner carries the pause
  assert.equal(P.bannerOf(ps).title, "Paused by the guardian");
}

// ---- the stepper fills the current step ----
{
  const s = stage(st0, dayStart(D) + 3 * 3600_000);
  assert.equal(P.stepProgress(s), 0.25);
  assert.match(P.stepsHTML(s), /aria-current="step" style="--p: 25.0%"/);
  const run = { day: D, done: false, t: 21_600, ticks: BURN_TICKS, seed: "aa".repeat(32), stake_hash: "bb".repeat(32) };
  assert.equal(P.stepProgress(stage({ ...st0, run }, dayRunAt(D) + 21_600_000)), 0.5);
}

// ---- the pot strip: the three tenses ----
{
  const r = P.potRange(T);
  assert.equal(P.fmtEst(r.burn[0]), "162");
  assert.equal(P.fmtEst(r.burn[1]), "14,948");
  assert.equal(P.fmtEst(r.share[0]), "650");
  assert.equal(P.fmtEst(r.share[1]), "1,300");
  const run = { day: D, done: false, t: 24_000, ticks: BURN_TICKS, seed: "aa".repeat(32), stake_hash: "bb".repeat(32) };
  const ps = stage({ ...st0, run }, dayRunAt(D) + 24_000_000);
  const html = P.potCardHTML({ ps, treasury: T, lead: 2, leadPct: 31.2 });
  assert.match(html, /Leading so far/);
  assert.match(html, /Not the result/);
  assert.match(html, /≈ 3,087/); // 0.38% of 812,400
  assert.match(html, /≈ 975/);   // 0.12%
  assert.match(html, /If <span class="opt" data-opt="2">0.50%<\/span> is picked, at today's treasury of 812,400 \$ANTO/);
  assert.doesNotMatch(html, /num-lg/, "an estimate is never in the large number type");
  assert.doesNotMatch(html, /\b(reward|win|won|prize)\b/i);
  // Staking: the range, and yesterday done.
  const s = stage(st0, dayStart(D) + 3600_000);
  const lastRow = { day: D - 1, index: 2, burned: tok(3087) + 12n * 10n ** 22n, reward: tok(974) + 88n * 10n ** 22n, detail: true };
  const h2 = P.potCardHTML({ ps: s, treasury: T, lastRow });
  assert.match(h2, /≈ 162–14,948/);
  assert.match(h2, /No leader yet/);
  assert.match(h2, /<b class="num">3,087.12<\/b> burned, <b class="num">974.88<\/b> shared/);
  // Due: the button, for everyone.
  const due = stage({ ...st0, run: { ...st0.run, day: D } }, dayEndAt(D) + 60_000);
  const h3 = P.potCardHTML({ ps: due, treasury: T });
  assert.match(h3, /data-act="execute" data-day="20756"/);
  assert.match(h3, /Run the payout for day 20,756/);
  assert.match(h3, /nothing to claim/);
  // No treasury read: the rule tense only.
  assert.match(P.potCardHTML({ ps: s, treasury: null }), /0.02–1.84%/);
  // Nobody staked on the picked size.
  assert.match(P.potCardHTML({ ps: s, treasury: T, lastRow: { ...lastRow, reward: 0n } }), /stayed in the treasury/);
  // Skipped yesterday.
  const sk = stage({ ...st0, lastBurnDay: D - 2, run: { ...st0.run, day: D - 2 } }, dayStart(D) + 1000);
  assert.match(P.potCardHTML({ ps: sk, treasury: T }), /No rollover/);
}

// ---- your part ----
{
  const run = { day: D, done: false, t: 24_000, ticks: BURN_TICKS, seed: "aa".repeat(32), stake_hash: "bb".repeat(32) };
  const ps = stage({ ...st0, run }, dayRunAt(D) + 24_000_000);
  const pot = [0, 1, 2, 3, 4].map((o) => potAmounts(T, o));
  const stakes = [0n, 0n, tok(25), 0n, 0n], totals = [0n, 0n, tok(140), 0n, 0n];
  const m = P.mineModel({ ps, me: { account: "me.testnet" }, pot, stakes, totals, weights: [0, 0, 17_000, 0, 0] });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].weight, 5000);
  assert.equal(P.fmtEst(m.rows[0].share), "174"); // 25/140 × 974.88
  const held = [[tok(25), 2]];
  const html = P.yoursHTML(m, ps, held);
  assert.match(html, /≈ 174<\/span> \$ANTO share if picked/);
  assert.match(html, /data-unstake="2">Withdraw/);
  assert.match(P.yoursHTML(m, ps, held, true), /data-unstake="2" disabled/);
  assert.equal(P.yoursHTML(m, ps, []), "");
  // Due, another size picked.
  const due = stage({ ...st0, run: { ...st0.run, day: D, winner_option: 1 } }, dayEndAt(D) + 60_000);
  assert.match(P.yoursHTML(P.mineModel({ ps: due, me: { account: "me" }, pot, stakes, totals }), due, held), /■ 0.25% was picked, not ◆/);
  // The share rounding is the contract's: floor(reward × mine / total).
  assert.equal(P.shareOf(100n, 1n, 3n), 33n);
  assert.equal(P.shareOf(100n, 1n, 0n), 0n);
}
{
  // Last paid day for this wallet.
  const entries = [["me", 0, 2, tok(25).toString()], ["you", 0, 2, tok(75).toString()], ["me", 3, 1, tok(9).toString()]];
  const row = { day: D - 1, index: 2, reward: tok(1000), burned: tok(3000), entries, detail: true };
  assert.match(P.lastShareHTML(row, "me"), /Your share of day 20,755: <span class="num">250<\/span> \$ANTO, already in your balance/);
  assert.match(P.lastShareHTML({ ...row, index: 1 }, "me"), /so no share this time/);
  assert.equal(P.lastShareHTML(row, "nobody"), "");
  const days = P.myDays([row, { day: D - 2, skipped: true }, { ...row, day: 20_000, index: 1 }], "me");
  assert.deepEqual(days.map((d) => [d.day, d.share]), [[D - 1, tok(250)], [D - 2, undefined], [20_000, null]]);
  assert.equal(days[2].pre, true);
  assert.match(P.myDaysHTML(days, tok(250)), /Lifetime shared to you: <span class="num">250<\/span>/);
}

// ---- one wallet budget ----
{
  const b = P.budget({ cap: tok(100), staked: tok(80), burn: tok(35), amount: 40, locked: true, lockDay: D });
  assert.equal(b.parts.locked, 35);
  assert.equal(b.parts.elsewhere, 45);
  assert.equal(b.parts.over, 20);
  assert.match(b.error, /That's 20 over your 100 \$ANTO cap\. Your cap covers the pot, markets and requests together: 35 on the pot \(locked until day 20,756 pays\), 45 on markets and requests\./);
  assert.match(P.budget({ cap: tok(100), staked: tok(100), burn: tok(100), amount: 0 }).error, /used your whole 100 \$ANTO cap/);
  assert.equal(P.budget({ cap: tok(100), staked: 0n, burn: 0n, amount: 25 }).error, "");
  assert.match(P.budget({ cap: tok(100), staked: 0n, burn: 0n, amount: 25, balance: tok(10) }).error, /balance of 10 \$ANTO/);
}

// ---- the calm summary: updates on the leader, the hour or the phase ----
{
  const run = { day: D, done: false, t: 24_000, ticks: BURN_TICKS, seed: "aa".repeat(32), stake_hash: "bb".repeat(32) };
  const ps = stage({ ...st0, run }, dayRunAt(D) + 24_000_000);
  const a = P.stageSummary({ ps, tick: 24_000, shares: [10, 24, 31, 20, 15], wallets: 12, staked: tok(640) });
  assert.equal(a.text, "Day 20,756, 18:40 UTC, tick 24,000 of 43,200. Leading so far: ◆ 0.50% with 31% of the trail, then ■ 0.25% with 24%. 12 wallets staked 640 $ANTO. The pick is made at 24:00 UTC.");
  assert.equal(P.stageSummary({ ps, tick: 24_500, shares: [10, 24, 31.4, 20, 15], wallets: 12 }).key, a.key);
  assert.notEqual(P.stageSummary({ ps, tick: 25_300, shares: [10, 24, 31, 20, 15], wallets: 12 }).key, a.key);
  assert.notEqual(P.stageSummary({ ps, tick: 24_500, shares: [10, 34, 31, 20, 15], wallets: 12 }).key, a.key);
  assert.match(P.stageSummary({ ps: stage(st0, dayStart(D) + 1000), wallets: 0 }).text, /sample map whose ants wander and collect nothing/);
}

// ---- receipts ----
{
  const entries = [["a", 0, 2, "5"], ["b", 0, 2, "7"], ["c", 0, 1, "1"]];
  const html = P.receiptsHTML({ day: D - 1, seed: "aa".repeat(32), stakeHash: "bb".repeat(32), hash: "cc".repeat(32), index: 2, burned: tok(3), reward: tok(1), tx: "8Hk2abcdQp", via: "crank", entries }, { verify: { state: "ok" } });
  assert.match(html, /replay\.html\?day=20755#pots/);
  assert.match(html, /with 2 wallets/);
  assert.match(html, /run by the next day's first crank/);
  assert.match(html, /data-state="match"/);
  assert.match(P.receiptsHTML({ day: D, seed: null }), /not run yet/);
  // A day from History's walk: no transaction, the menu's amounts marked as such.
  const walked = P.receiptsHTML({ day: D, seed: null, tx: `known-${D}`, approx: true, burned: 3n * 10n ** 24n, reward: 10n ** 24n, index: 2 });
  assert.match(walked, /paid<span class="why">burned <span class="num">≈ 3/);
  assert.doesNotMatch(walked, /nearblocks/);
}

console.log("pot: ok");
