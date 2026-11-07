// The Daily Pot page (web/pot.html, docs/DAILY_POT_PAGE.md): where the day
// is, the pot strip in its tenses (rule, estimate, done), Your part, the
// wallet budget, the calm stage summary, Your days and the receipts. Pure:
// chain data in, models and HTML strings out, so Node can test it (pass `now`
// where the clock matters). The loader is burnchain.mjs; the pot maths and
// the day clock are burn.mjs.
//
// Copy rules: burn, share and estimate. A size is picked, never "won". An
// estimate is never set in the large number type and always names its two
// conditions (the size picked, today's treasury).

import { BURN_TICKS } from "../sim/js/antosim.mjs";
import {
  POT_MENU_BPS, BURN_HANDICAP, ONE, N_OPTIONS, BURN_COLONY, HANDICAP_FROM_DAY,
  potAmounts, dayRunAt, dayEndAt, dayStart, clockTick, isqrt, fmtTokens, fmtTokens2,
} from "./burn.mjs";
import { GLYPHS, BURN_MENU } from "./round.mjs";
import { GENESIS_MS, PERIOD_MS } from "./random.mjs";
import { esc, hms, hashHTML } from "./ui.mjs";

// The chain is "stalled" when its stored tick is this far behind the clock
// (90 minutes), or when no crank has drawn the seed 90 minutes after 12:00.
export const STALL_TICKS = 5_400;
export const SEED_LATE_MS = 90 * 60_000;
// A finished day's payout is "overdue" this long after 24:00.
export const OVERDUE_MS = 30 * 60_000;
// The last quarter hour of staking: the stepper's line warns about 12:00.
export const CLOSING_MS = 15 * 60_000;
// The calm summary updates at most once per hour of the run.
export const SUMMARY_TICKS = 3_600;
export const MY_DAYS = 14;

// drand quicknet's round for a time, as contract/src/drand.rs round_after:
// the first round published after `ms`, which a day's seed commits to.
export const roundAfter = (ms) => (ms < GENESIS_MS ? 1 : Math.floor((ms - GENESIS_MS) / PERIOD_MS) + 2);
export const dayDrand = (day) => roundAfter(dayRunAt(day));

const n = (x) => Number(x).toLocaleString("en");
export const utc = (ms) => new Date(ms).toISOString().slice(11, 16);
export const shortDate = (day) => new Date(dayStart(day)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const sizeHTML = (o) => `<span class="opt" data-opt="${o}">${esc(BURN_MENU[o])}</span>`;
export const sizeText = (o) => `${GLYPHS[o]} ${BURN_MENU[o]}`;
// An estimate in whole $ANTO, rounded to the nearest token.
export const fmtEst = (base) => ((BigInt(base) + ONE / 2n) / ONE).toLocaleString("en");
const pillHTML = (state, text) =>
  `<span class="pill" data-state="${state}">${state === "running" ? `<i class="pill__g" aria-hidden="true"></i>` : ""}${esc(text)}</span>`;
const isDue = (ps) => ps.stage === "due" || ps.stage === "overdue";

// Which day the page is about and what is happening to it. `bv` is
// burnView(st, now). Stages:
//   staking, closing (its last 15 min), waiting (after 12:00, no seed yet),
//   running (today's colony on chain),
//   finishing (an earlier day's run not at its last tick yet),
//   due, overdue (an earlier day's run done, its payout not run).
// `last` is what happened to the day before the focus day: "paid",
// "skipped" or null (unknown).
export function potStage(st, bv, now = bv.now) {
  const day = bv.day, paused = !!st.paused;
  const base = { day, now, paused, stalled: false, lag: 0, chainT: null, clockT: null, last: null };
  if (bv.prev) {
    const run = bv.prev.run, focus = run.day;
    if (bv.prev.state === "unfinished") {
      const clockT = clockTick(focus, now, run.ticks ?? BURN_TICKS), lag = Math.max(0, clockT - run.t);
      return { ...base, focus, stage: "finishing", run, chainT: run.t, clockT, lag, stalled: lag > STALL_TICKS, skipAt: dayRunAt(focus + 1) };
    }
    return { ...base, focus, stage: now - dayEndAt(focus) > OVERDUE_MS ? "overdue" : "due", run, picked: run.winner_option, skipAt: dayRunAt(focus + 1) };
  }
  const last = st.lastBurnDay == null ? null : st.lastBurnDay >= day - 1 ? "paid" : "skipped";
  if (bv.phase === "staking") return { ...base, focus: day, last, stage: dayRunAt(day) - now <= CLOSING_MS ? "closing" : "staking" };
  if (bv.phase === "waiting") return { ...base, focus: day, last, stage: "waiting", stalled: now - dayRunAt(day) > SEED_LATE_MS };
  const tk = bv.tick;
  return { ...base, focus: day, last, stage: "running", run: bv.run, chainT: tk.chain, clockT: tk.clock, lag: tk.lag, stalled: tk.lag > STALL_TICKS };
}

// ---- the stepper: the day as five steps (§6) ----

export const STEPS = ["Staking", "Seed", "Colony runs", "Final tick", "Paid"];
export function stepStates(ps) {
  const at = { staking: 0, closing: 0, waiting: 1, running: 2, finishing: 2, due: 4, overdue: 4 }[ps.stage];
  return STEPS.map((_, i) => (i < at ? "past" : i > at ? "next" : ps.stalled ? "stalled" : "now"));
}

export function stepsHTML(ps) {
  const R = n(dayDrand(ps.focus)), states = stepStates(ps), due = isDue(ps);
  const at = [
    states[0] === "past" ? "stakes frozen at 12:00" : `00:00–12:00 · seed commits to drand #${R}`,
    `12:00 · drand #${R}`,
    ps.stage === "running" || ps.stage === "finishing"
      ? `tick ${n(Math.min(ps.clockT, BURN_TICKS))} / ${n(BURN_TICKS)} · chain at ${n(ps.chainT)}`
      : "12:00–24:00",
    due ? `24:00 · ${sizeText(ps.picked)} picked` : "24:00 · pick known",
    due ? "anyone can run it" : "from 24:00 · anyone can run",
  ];
  const tips = [
    "Stake on a size. A stake counts for today until 12:00 UTC, then from tomorrow.",
    "The first crank_burn after 12:00 brings drand's signature, which the contract checks, and freezes the stakes.",
    "Each crank_burn steps the colony up to 1,500 ticks, never past the clock (one tick a second).",
    "The last tick falls at 24:00 UTC. Then the pick is fixed.",
    "execute_burn burns the burn part and shares the rest in one transaction. If nobody runs it, the next day's first crank does.",
  ];
  return STEPS.map((label, i) => {
    const s = states[i], cur = s === "now" || s === "stalled";
    return `<li data-state="${s}"${cur ? ` aria-current="step" style="--p: ${(stepProgress(ps) * 100).toFixed(1)}%"` : ""} title="${esc(tips[i])}"><b>${esc(s === "stalled" ? `${label} · stalled` : label)}</b><span class="stepper__at">${esc(at[i])}</span></li>`;
  }).join("");
}

// How far through the current step the day is, 0..1: staking by the clock
// to 12:00, the run by its tick. The stepper's bar fills that far, so the
// stepper is the page's one progress bar.
export function stepProgress(ps, now = ps.now) {
  const d = ps.focus, frac = (x) => Math.min(1, Math.max(0, x));
  switch (ps.stage) {
    case "staking":
    case "closing": return frac((now - dayStart(d)) / (dayRunAt(d) - dayStart(d)));
    case "running": return frac(ps.clockT / BURN_TICKS);
    case "finishing": return frac(ps.chainT / BURN_TICKS);
    default: return 1;
  }
}

// The one time that matters now, for the stepper's clock.
export function clockOf(ps, now = ps.now) {
  const d = ps.focus; // paused: the banner says so; the clock still tells the day's time
  switch (ps.stage) {
    case "staking":
    case "closing": return { label: "Staking closes in", value: hms(dayRunAt(d) - now) };
    case "waiting": return { label: ps.stalled ? "Still waiting for" : "Waiting for", value: `drand #${n(dayDrand(d))}` };
    case "running": return { label: "Pick at 24:00 UTC, in", value: hms(dayEndAt(d) - now) };
    case "finishing": return { label: "Chain catching up", value: `${n(ps.chainT)} / ${n(BURN_TICKS)}` };
    default: return { label: ps.stage === "overdue" ? "Payout overdue" : "Payout due", value: `since ${utc(dayEndAt(d))} UTC` };
  }
}

// One sentence: what is happening now.
export function dayLine(ps) {
  const d = ps.focus, R = n(dayDrand(d));
  return {
    staking: `Staking is open. A stake placed before 12:00 UTC counts for today, day ${n(d)}.`,
    closing: "Staking closes at 12:00 UTC. A stake that lands after 12:00 counts from tomorrow; your wallet's confirmation says which day.",
    waiting: `Today's stakes froze at 12:00 UTC. Waiting for drand #${R}: the first crank brings its signature, and the contract checks it.`,
    running: "The colony is running. The pick is made at 24:00 UTC.",
    finishing: `Day ${n(d)} is over, but the chain has stored its colony only to tick ${n(ps.chainT)}. Each crank stores up to 1,500 more.`,
    due: `The colony picked ${sizeText(ps.picked)}. Anyone can now run the payout.`,
    overdue: `Day ${n(d)}'s payout hasn't run yet. Anyone can run it; if nobody does, the next day's first crank runs it.`,
  }[ps.stage];
}

// Stalled, paused and the like: a banner, or null.
export function bannerOf(ps) {
  if (ps.paused) {
    return { kind: "hold", g: "‖", title: "Paused by the guardian", text: "Staking, cranks and payouts wait until it is lifted. You can withdraw your stake now; the Burn lock is lifted while paused." };
  }
  if (ps.stage === "waiting" && ps.stalled) {
    return { kind: "hold", g: "!", title: `Stalled: no seed since 12:00 UTC`, crank: true,
      text: `Nobody has brought in drand #${n(dayDrand(ps.focus))} yet. Anyone can send the first crank (about 0.02 NEAR of gas). If drand hasn't published it yet, nothing can start until it does; nobody can pick the seed.` };
  }
  if ((ps.stage === "running" || ps.stage === "finishing") && ps.stalled) {
    const since = utc(dayRunAt(ps.focus) + ps.chainT * 1000);
    return { kind: "hold", g: "!", title: `Stalled: the chain is at tick ${n(ps.chainT)}`, crank: true,
      text: `The colony hasn't been cranked since about ${since} UTC. The page runs it ahead from the seed, so the map is still right; the chain needs a crank to catch up. Anyone can crank (about 0.02 NEAR of gas).` +
        (ps.stage === "finishing" ? ` Skipped at ${utc(ps.skipAt)} UTC on ${shortDate(ps.focus + 1)} if the run hasn't finished by then. There is no default split.` : "") };
  }
  if (ps.stage === "overdue") {
    return { kind: "hold", g: "!", title: `Day ${n(ps.focus)}'s payout hasn't run`,
      text: `Anyone can run it. If nobody does, the next run starts at 12:00 UTC and runs it first.` };
  }
  return null;
}

// ---- the pot card ----

// The burn and share range over the five sizes at a treasury, in base units.
export function potRange(treasury) {
  const all = POT_MENU_BPS.map((_, o) => potAmounts(treasury, o));
  const pick = (k, f) => all.reduce((a, p) => (f(p[k], a) ? p[k] : a), all[0][k]);
  return { burn: [pick("burn", (x, a) => x < a), pick("burn", (x, a) => x > a)], share: [pick("reward", (x, a) => x < a), pick("reward", (x, a) => x > a)] };
}

const numBlock = (part, label, tense, value, unit = " $ANTO") =>
  `<div class="pot-card__num" data-part="${part}"><dt>${label}${tense === "estimate" ? ` <span class="pot-card__tense">estimate</span>` : ""}</dt>` +
  `<dd>${tense === "estimate" ? `<span class="est">${value}</span>` : `<span class="num">${value}</span>`}<span class="pot-card__unit">${unit}</span></dd></div>`;

// The pot strip at the top of the stake card: the two numbers, what decides,
// the payout while it is due, and the day before in one line. `x`:
//   ps (potStage), treasury (bigint|null),
//   lead, leadPct, leadAt: the size leading so far on today's run (-1: none),
//   lastRow: the history row of the day before the focus day, if read,
//   payoutBusy: the payout transaction is on its way.
export function potCardHTML(x) {
  const { ps, treasury } = x, d = ps.focus, due = isDue(ps), running = ps.stage === "running";
  const o = due ? ps.picked : running ? x.lead ?? -1 : -1;
  const head = due || ps.stage === "finishing" ? `Day ${n(d)}'s pot` : "Today's pot";
  const lead = due ? `The colony picked ${sizeHTML(o)} at 24:00 UTC. ${pillHTML("pending", ps.stage === "overdue" ? "Payout overdue" : "Payout due")}`
    : running && o >= 0 ? `<b>Leading so far: ${sizeHTML(o)}</b> · ${x.leadPct.toFixed(0)}% of the trail at ${utc(x.leadAt ?? ps.now)} UTC. Not the result: the colony picks at 24:00.`
    : running ? "No trail yet. The colony picks the size at 24:00 UTC."
    : ps.stage === "finishing" ? `The chain has stored ${n(ps.chainT)} of ${n(BURN_TICKS)} ticks; the pick is known once the last one is cranked in.`
    : ps.stage === "waiting" ? `No leader yet: the colony starts once drand #${n(dayDrand(d))} is brought in, and picks the size at 24:00 UTC.`
    : "No leader yet. The colony picks the size at 24:00 UTC: most of the pot burns, a small part is shared with the stakers on that size.";

  let nums, cond;
  if (treasury == null) {
    nums = numBlock("burn", "Burn", "rule", "0.02–1.84%", " of the treasury") + numBlock("share", "Share", "rule", "0.08–0.16%", " of the treasury");
    cond = "Taken from the treasury when the payout runs. The contract caps the pot at 2.00%.";
  } else if (o >= 0) {
    const p = potAmounts(treasury, o);
    nums = numBlock("burn", "Burn", "estimate", `≈ ${fmtEst(p.burn)}`) + numBlock("share", "Share", "estimate", `≈ ${fmtEst(p.reward)}`);
    cond = due ? `At today's treasury of ${fmtTokens(treasury)} $ANTO; the exact amounts are fixed when the payout runs.`
      : `If ${sizeHTML(o)} is picked, at today's treasury of ${fmtTokens(treasury)} $ANTO.`;
  } else {
    const r = potRange(treasury);
    nums = numBlock("burn", "Burn", "estimate", `≈ ${fmtEst(r.burn[0])}–${fmtEst(r.burn[1])}`) + numBlock("share", "Share", "estimate", `≈ ${fmtEst(r.share[0])}–${fmtEst(r.share[1])}`);
    cond = `Depends on the size picked, at today's treasury of ${fmtTokens(treasury)} $ANTO.`;
  }
  if (ps.stage === "finishing" || due) cond += ` If it isn't paid by ${utc(ps.skipAt)} UTC on ${shortDate(d + 1)}, the day is skipped: nothing burns and nothing is shared.`;
  const action = due
    ? `<div class="pot-card__action"><button class="btn btn--primary${x.payoutBusy ? " is-loading" : ""}" type="button" data-act="execute" data-day="${d}"${ps.paused || x.payoutBusy ? " disabled" : ""}>${x.payoutBusy ? "Running the payout…" : `Run the payout for day ${n(d)}`}</button>` +
      `<span class="why">${ps.paused ? "Paused by the guardian: payouts wait until it is lifted." : "Anyone can run it, for about 0.02 NEAR of gas. There is nothing to claim: shares go straight to the stakers' balances."}</span></div>`
    : "";
  return `<div class="pot-card__head"><h3 id="pot-title">${head}</h3><a class="what" href="docs.html#burn">Who decides</a></div>` +
    `<dl class="pot-card__nums">${nums}</dl>` +
    `<p class="pot-card__lead">${lead}</p>` +
    `<p class="pot-card__cond">${cond}</p>` +
    action + lastHTML(x);
}

// The day before the focus day, in one line under the strip.
function lastHTML(x) {
  const { ps } = x, d = ps.focus - 1;
  if (!ps.last) return "";
  if (ps.last === "skipped") {
    return `<p class="pot-card__last" data-tense="skipped">${pillHTML("skipped", "Skipped")} Day ${n(d)} was skipped: its run didn't finish before the next day's started, so nothing burned or was shared. No rollover: today's pot is still at most 2.00%.</p>`;
  }
  const r = x.lastRow;
  if (!r || r.day !== d || r.burned === undefined) {
    return `<p class="pot-card__last" data-tense="done">${pillHTML("done", "Paid")} Day ${n(d)}'s pot is paid. <a href="#receipts">Receipts ↓</a></p>`;
  }
  return `<p class="pot-card__last" data-tense="done">${pillHTML("done", "Paid")} Day ${n(d)}: ${sizeHTML(r.index)} picked, <b class="num">${fmtTokens2(r.burned)}</b> burned, <b class="num">${fmtTokens2(r.reward)}</b> shared` +
    (r.reward === 0n ? ` (nobody staked on it, so its shared part stayed in the treasury)` : "") + `. <a href="#receipts">Receipts ↓</a></p>`;
}

// ---- your part ----

// Per-size raw stake (yocto) of `account` in snapshot entries.
export function mineIn(entries, account) {
  const m = new Array(N_OPTIONS).fill(0n);
  for (const [a, c, o, v] of entries ?? []) if (a === account && c === BURN_COLONY && o < N_OPTIONS) m[o] += BigInt(v);
  return m;
}
// Raw stake on size `o` over all wallets of snapshot entries.
const totalOn = (entries, o) => entries.filter(([, c, x]) => c === BURN_COLONY && x === o).reduce((a, e) => a + BigInt(e[3]), 0n);

// The share of `reward` a stake of `mine` gets out of `total` on the picked
// size: floor(reward × mine / total), as token/src/reward.rs distribute.
export const shareOf = (reward, mine, total) => (BigInt(total) > 0n ? (BigInt(reward) * BigInt(mine)) / BigInt(total) : 0n);

// Weight (milli sqrt-tokens) of a stake in yocto: isqrt(yocto) / 10^9, as
// the contract's stake weights.
export const weightOf = (yocto) => Number(isqrt(BigInt(yocto)) / 10n ** 9n);

// Your part's rows. `x`:
//   ps, me (st.me), pot (st.pot),
//   stakes: yocto per size that count for the focus day (the live stakes
//     while staking, the frozen snapshot from 12:00),
//   totals: raw stake per size for the focus day, all wallets,
//   weights: milli sqrt-tokens per size for the focus day, all wallets.
export function mineModel(x) {
  const { ps, me } = x;
  if (!me) return { wallet: false, rows: [] };
  const rows = [];
  for (let o = 0; o < N_OPTIONS; o++) {
    const s = x.stakes[o];
    if (s <= 0n) continue;
    const w = weightOf(s), all = x.weights?.[o] ?? 0;
    const reward = x.pot?.[o]?.reward ?? null;
    rows.push({
      o, stake: s, weight: w, of: all > 0 ? Math.min(100, (w / all) * 100) : 100, handicap: BURN_HANDICAP[o],
      total: x.totals?.[o] ?? s, reward,
      share: reward === null ? null : shareOf(reward, s, x.totals?.[o] ?? s),
      picked: isDue(ps) ? ps.picked === o : null,
    });
  }
  return { wallet: true, rows, account: me.account };
}

// Your stakes, under the staker ants: one row per size you hold now, with
// the share it would bring (from `m`, the focus day's model) and Withdraw.
// `held` is [[yocto, size]]; Withdraw is off while the stake is locked.
export function yoursHTML(m, ps, held, locked = false) {
  if (!held.length) return "";
  const due = isDue(ps);
  return held.map(([v, o]) => {
    const r = m.rows.find((x) => x.o === o);
    const tip = r?.share == null ? "" : ` title="${esc(shareTip(r))}"`;
    const est = !r || r.share === null ? ""
      : due && r.picked ? `<span class="est"${tip}>≈ ${fmtEst(r.share)}</span> $ANTO share, paid by the payout`
      : due ? `${sizeText(ps.picked)} was picked, not ${GLYPHS[o]}`
      : `<span class="est"${tip}>≈ ${fmtEst(r.share)}</span> $ANTO share if picked`;
    return `<li>${sizeHTML(o)} <span class="num">${fmtTokens2(v)}</span> $ANTO` +
      (est ? `<span class="mine__note">${est}</span>` : "") +
      `<button class="btn btn--sm btn--ghost" type="button" data-unstake="${o}"${locked ? " disabled" : ""}>Withdraw</button></li>`;
  }).join("");
}

export const shareTip = (r) =>
  `${fmtTokens2(r.stake)} of the ${fmtTokens2(r.total)} $ANTO staked on ${sizeText(r.o)} × ${fmtTokens2(r.reward)} $ANTO shared = ${fmtTokens2(r.share)}. ` +
  `Changes as others stake until 12:00 UTC, and with the treasury until the payout.`;

// What the last paid day did for this wallet. `row` is a history row.
export function lastShareHTML(row, account) {
  if (!row?.entries || row.index == null || !account) return "";
  const mine = mineIn(row.entries, account);
  if (!mine.some((v) => v > 0n)) return "";
  const p = row.index;
  if (mine[p] > 0n) {
    const got = shareOf(row.reward ?? 0n, mine[p], totalOn(row.entries, p));
    return `<p class="mine__last">${pillHTML("done", "Paid")} Your share of day ${n(row.day)}: <span class="num">${fmtTokens2(got)}</span> $ANTO, already in your balance. There is nothing to claim.</p>`;
  }
  const on = mine.findIndex((v) => v > 0n);
  return `<p class="mine__last">${sizeText(p)} was picked on day ${n(row.day)}; your stake was on ${sizeText(on)}, so no share this time. Your stake keeps counting for the next days until you withdraw it.</p>`;
}

// ---- one wallet budget ----

// The per-wallet cap covers the pot, markets and requests together. cap,
// staked (wallet_total) and burn (this wallet's Burn stakes) in yocto,
// amount in whole tokens. Returns the bar's parts in tokens, the text and,
// when the amount doesn't fit, the error (3.3.1: it says by how much and
// where the rest of the budget is).
export function budget({ cap, staked, burn, amount, locked = false, lockDay = null, balance = null, claimed = true }) {
  const T = (y) => Number(BigInt(y) / (ONE / 1000n)) / 1000;
  const r = (v) => Math.round(v * 100) / 100;
  const c = T(cap), pot = T(burn), elsewhere = Math.max(0, T(staked) - pot), free = Math.max(0, c - pot - elsewhere);
  const over = Math.max(0, amount - free), mine = Math.min(amount, free);
  const where = [
    pot ? `${r(pot)} on the pot${locked ? ` (locked until ${lockDay == null ? "its day" : `day ${n(lockDay)}`} pays)` : ""}` : "",
    elsewhere ? `${r(elsewhere)} on markets and requests` : "",
  ].filter(Boolean);
  const text = `${where.length ? `${where.join(", ")}. ` : ""}<b>${r(Math.max(0, free - mine))}</b> of your ${r(c)} $ANTO cap free.`;
  let error = "";
  if (free <= 0) error = `You've used your whole ${r(c)} $ANTO cap: ${where.join(", ")}.`;
  else if (over > 0) error = `That's ${r(over)} over your ${r(c)} $ANTO cap. Your cap covers the pot, markets and requests together${where.length ? `: ${where.join(", ")}` : ""}.`;
  else if (claimed && balance !== null && amount > T(balance)) error = `That's more than your balance of ${r(T(balance))} $ANTO.`;
  return { parts: { locked: locked ? pot : 0, pot: locked ? 0 : pot, elsewhere, this: mine, over, free: Math.max(0, free - mine) }, text, error, free };
}

// ---- the calm stage summary ----

// One short paragraph for the map's text alternative. `key` changes only
// when the leader changes, every SUMMARY_TICKS ticks or at a phase change,
// so a polite live region speaks rarely. `x`: ps, tick, shares (percent per
// size), wallets (count or null), staked (yocto).
export function stageSummary(x) {
  const { ps } = x, d = ps.focus;
  const order = (x.shares ?? []).map((v, o) => [v, o]).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const lead = order.length ? order[0][1] : -1;
  const who = x.wallets ? `${n(x.wallets)} ${x.wallets === 1 ? "wallet" : "wallets"} staked ${fmtTokens(x.staked ?? 0n)} $ANTO.` : "No stakes yet.";
  const pre = ps.paused ? "Paused by the guardian. " : "";
  if (ps.stage === "running") {
    const t = x.tick ?? 0, hour = Math.floor(t / SUMMARY_TICKS);
    const top = order.slice(0, 2).map(([v, o], i) => `${sizeText(o)} with ${v.toFixed(0)}%${i ? "" : " of the trail"}`);
    return {
      key: `running:${d}:${lead}:${hour}:${ps.paused}`,
      text: `${pre}Day ${n(d)}, ${utc(dayRunAt(d) + t * 1000)} UTC, tick ${n(t)} of ${n(BURN_TICKS)}. ` +
        (top.length ? `Leading so far: ${top.join(", then ")}. ` : "No trail yet. ") + `${who} The pick is made at 24:00 UTC.`,
    };
  }
  const picked = ps.picked == null ? "a size" : sizeText(ps.picked);
  const text = {
    staking: `Day ${n(d)}: staking is open until 12:00 UTC. The map is a sample map whose ants wander and collect nothing; today's real map is drawn at 12:00 UTC from drand #${n(dayDrand(d))}. ${who}`,
    closing: `Day ${n(d)}: staking closes at 12:00 UTC. The map is a sample map; nothing is collected until the run starts. ${who}`,
    waiting: `Day ${n(d)}: stakes froze at 12:00 UTC. Waiting for drand #${n(dayDrand(d))} to draw the map. ${who}`,
    finishing: `Day ${n(d)}'s colony ran to 24:00 UTC; the chain has stored ${n(ps.chainT)} of ${n(BURN_TICKS)} ticks. The pick is known once the last tick is cranked in.`,
    due: `Day ${n(d)}'s colony picked ${picked}. The payout can now run.`,
    overdue: `Day ${n(d)}'s colony picked ${picked}. The payout is overdue; anyone can run it.`,
  }[ps.stage];
  return { key: `${ps.stage}:${d}:${x.wallets ?? 0}:${ps.paused}`, text: pre + text };
}

// ---- your days and the receipts ----

// This wallet's last MY_DAYS days from history rows (burnRow), newest first.
export function myDays(rows, account) {
  if (!account) return [];
  const out = [];
  for (const r of rows) {
    if (out.length >= MY_DAYS) break;
    if (r.skipped) { out.push({ day: r.day, skipped: true }); continue; }
    if (!r.detail || !r.entries) continue;
    const mine = mineIn(r.entries, account);
    out.push({
      day: r.day, picked: r.index, pre: r.day < HANDICAP_FROM_DAY,
      stakes: mine.map((v, o) => [v, o]).filter(([v]) => v > 0n),
      share: mine[r.index] > 0n ? shareOf(r.reward ?? 0n, mine[r.index], totalOn(r.entries, r.index)) : null,
    });
  }
  return out;
}

export function myDaysHTML(days, earned) {
  const life = earned == null ? "" : `<p class="my-days__life">Lifetime shared to you: <span class="num">${fmtTokens2(earned)}</span> $ANTO.</p>`;
  if (!days.length) return `<p class="text-sm text-muted">No paid day with your stake among the days this page could read.</p>${life}`;
  return `<div class="table-wrap"><table class="table table--compact my-days__table"><thead><tr><th scope="col">Day</th><th scope="col">Your stake</th><th scope="col">Picked</th><th scope="col" class="num">Your share</th></tr></thead><tbody>` +
    days.map((d) => d.skipped
      ? `<tr><th scope="row" class="num">${n(d.day)}</th><td colspan="3">${pillHTML("skipped", "Skipped")} nothing burned or shared</td></tr>`
      : `<tr><th scope="row" class="num">${n(d.day)}</th>` +
        `<td data-label="Your stake">${d.stakes.length ? d.stakes.map(([v, o]) => `<span class="num">${fmtTokens2(v)}</span> on ${sizeHTML(o)}`).join("<br>") : `<span class="text-faint">—</span>`}</td>` +
        `<td data-label="Picked">${sizeHTML(d.picked)}</td>` +
        `<td class="num" data-label="Your share">${d.share !== null ? fmtTokens2(d.share) : d.stakes.length ? `<span class="text-faint">not picked</span>` : `<span class="text-faint">—</span>`}` +
        `${d.pre ? `<span class="why">first rules: no handicap, the whole pot burned</span>` : ""}</td></tr>`).join("") +
    `</tbody></table></div>${life}`;
}

// Receipts for one day. `r`: { day, seed, stakeHash, hash, index, burned,
// reward, tx, via, entries } (a history row, or the run waiting for its
// payout), `verify`: { state: running|ok|bad|error, pct }.
export function receiptsHTML(r, { verify = null } = {}) {
  const wallets = r.entries && r.index != null
    ? new Set(r.entries.filter(([, c, o]) => c === BURN_COLONY && o === r.index).map(([a]) => a)).size : null;
  const badge = !verify ? "" : verify.state === "ok" ? pillHTML("match", "Match")
    : verify.state === "bad" ? pillHTML("mismatch", "Mismatch")
    : verify.state === "running" ? pillHTML("running", `Checking ${verify.pct ?? 0}%`)
    : verify.state === "error" ? pillHTML("pending", "Could not check") : "";
  const tx = r.tx && !String(r.tx).startsWith("known-") ? String(r.tx) : null;
  // A row from History's walk has no transaction, only the menu's amounts at the day's treasury.
  const approx = r.approx ? "≈ " : "";
  const paid = r.burned !== undefined ? `<span class="why">burned <span class="num">${approx}${fmtTokens2(r.burned)}</span> $ANTO · shared <span class="num">${approx}${fmtTokens2(r.reward)}</span> $ANTO${wallets != null ? ` with ${n(wallets)} ${wallets === 1 ? "wallet" : "wallets"}` : ""}${r.via === "crank" ? " · run by the next day's first crank" : ""}</span>` : "";
  const rows = [
    ["Seed", r.seed ? `${hashHTML(r.seed, `day ${r.day} seed`)}<span class="why">from drand #${n(dayDrand(r.day))}, signature checked on chain</span>` : `<span class="text-faint">not drawn yet</span>`],
    ["Stake snapshot", r.stakeHash ? hashHTML(r.stakeHash, `day ${r.day} stake snapshot hash`) : `<span class="text-faint">—</span>`],
    ["Result hash", r.hash ? `${hashHTML(r.hash, `day ${r.day} result hash`)} ${badge}` : `<span class="text-faint">at tick ${n(BURN_TICKS)}</span>`],
    ["Payout", tx
      ? `<a class="mono" href="https://testnet.nearblocks.io/txns/${esc(tx)}" target="_blank" rel="noopener">${esc(tx.slice(0, 6))}…${esc(tx.slice(-4))} ↗</a>${paid}`
      : paid ? `paid${paid}` : `<span class="text-faint">not run yet</span>`],
  ];
  const rerun = r.entries && r.hash && verify?.state !== "ok" && verify?.state !== "running";
  return `<dl class="kv day-receipts__kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` +
    (verify?.state === "bad" ? `<p class="field__error">✗ Mismatch on day ${n(r.day)}: ${esc(verify.why ?? "the result differs from the chain's")}. <a href="replay.html?day=${r.day}#pots">See which input differs</a>.</p>` : "") +
    `<div class="cluster"><a class="btn" href="replay.html?day=${r.day}#pots">Verify from seed ↗</a>` +
    (rerun ? `<button class="btn btn--ghost" type="button" data-verify-day="${r.day}">Re-run all ${n(BURN_TICKS)} ticks here</button>` : "") + `</div>`;
}
