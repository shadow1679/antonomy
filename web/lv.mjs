// Shared by the Live overview (live.html) and the market details page
// (market.html): formatting, the round's steps and clock, a market's status
// line, its stacked bar, and one in-browser verification per market.

import { KINDS } from "../sim/js/antosim.mjs";
import { verifyMarket } from "./roundchain.mjs";
import { tokens } from "./chain.mjs";
import { esc, hms } from "./ui.mjs";

export const LIVE_TPS = 12; // live pages play the colonies at the player's 1× pace (12 ticks/s); faster speeds are on the replay page
export const pct = (b) => (b / 100).toFixed(1);
export const utc = (ms) => new Date(ms).toISOString().slice(11, 16) + " UTC";
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const tick0 = () => new Promise((r) => setTimeout(r, 0));
export const fmtT = (y) => tokens(y.toString()).toLocaleString("en", { maximumFractionDigits: 3 });
export const sumBig = (xs) => xs.reduce((a, x) => a + BigInt(x), 0n);
export const argmax = (xs) => xs.reduce((w, x, i) => (x > xs[w] ? i : w), 0);
export const bigJSON = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v));
export const deltaCls = (d) => (d > 0 ? "delta--up" : d < 0 ? "delta--down" : "delta--flat");
// Status glyphs (◌ ✓ ✗ ○) are set in mono, which draws them; the UI font does not.
export const gl = (s) => String(s).replace(/^([◌✓✗○]) /, '<span class="lv-g">$1</span> ');

// Links keep a ?contract= override.
const carry = () => { const c = new URLSearchParams(location.search).get("contract"); return c ? `&contract=${encodeURIComponent(c)}` : ""; };
export const marketHref = (key) => `market.html?m=${encodeURIComponent(key)}${carry()}`;
// A requested forecast's details, on the market page.
export const requestHref = (id) => `market.html?r=${id}${carry()}`;
export const liveHref = (hash = "") => { const c = carry(); return `live.html${c ? `?${c.slice(1)}` : ""}${hash}`; };
export const recruitHref = (hash = "") => { const c = carry(); return `recruit.html${c ? `?${c.slice(1)}` : ""}${hash}`; };
// History (replay.html): `query` like "round=4", `hash` like "#check".
export const historyHref = (query = "", hash = "") => { const qs = `${query}${carry()}`.replace(/^&/, ""); return `replay.html${qs ? `?${qs}` : ""}${hash}`; };

// One stacked bar: segments in the option colours, the glyph on any wide one.
export function stackHTML(shares) {
  return `<span class="lv-stack">${shares.map((s, o) => (s > 0
    ? `<i data-opt="${o}" style="--w: ${(s / 100).toFixed(2)}"${s >= 900 ? ' class="is-wide"' : ""}></i>` : "")).join("")}</span>`;
}

// ---- the round's steps and the one clock that matters ----

// The previous round (last_round) carries no phase or times: it is finished.
export const finished = (rd) => (rd && !rd.phase ? { ...rd, phase: "done" } : rd);

export const STEPS = [["posting", "Staking"], ["agents", "Agents post"], ["ready", "Seed"], ["running", "Colonies run"], ["done", "Result"]];

export function stepsHTML(round) {
  const p = round.phase, skipped = p === "skipped";
  const cur = STEPS.findIndex((s) => s[0] === p);
  const at = (ms) => (Number.isFinite(ms) ? `until ${utc(ms)}` : "");
  const until = { posting: () => at(round.closeMs), agents: () => at(round.publishMs) };
  return STEPS.map(([key, label], i) => {
    const st = skipped ? (i === 0 ? "skipped" : "next") : p === "done" || i < cur ? "past" : i === cur ? "now" : "next";
    const glyph = st === "past" ? "✓ " : st === "now" ? "◌ " : st === "skipped" ? "✗ " : "";
    return `<li data-state="${st}"${st === "now" ? ' aria-current="step"' : ""}><b>${gl(glyph + (st === "skipped" ? "Skipped" : label))}</b><span class="lv-steps__at">${until[key]?.() ?? ""}</span></li>`;
  }).join("");
}

// [label, value, detail] for the round's clock.
export function clockOf(round, now = Date.now()) {
  const n = round.markets.length, cranked = round.markets.reduce((a, m) => a + m.cranked, 0);
  const clocks = {
    posting: () => ["Staking closes in", hms(round.closeMs - now), `at ${utc(round.closeMs)}`],
    agents: () => ["Agents' window ends in", hms(round.publishMs - now), `at ${utc(round.publishMs)}`],
    ready: () => ["Ready to crank", `0 / ${n * KINDS.length}`, "colonies cranked"],
    running: () => ["Colonies cranked", `${cranked} / ${n * KINDS.length}`, "on-chain, one per call"],
    done: () => ["Result", "✓ final", "all colonies cranked"],
    skipped: () => ["Round", "✗ skipped", "no keeper quorum"],
  };
  return clocks[round.phase]?.() ?? ["Round", round.phase, ""];
}

// ---- verification: each market's cranked colonies re-run here once ----

// What a market's card and page show depends on all of this, and nothing else.
export const sigOf = (m) => JSON.stringify([m.key, m.marketId, m.odds, m.stakes, m.forecasters?.map((f) => f.chainHash), m.swarm, m.marketHash, m.run?.seed, m.agents?.posts]);

export function makeVerifier(onDone) {
  const cache = new Map(); // market signature -> { v, p }
  return (m) => {
    if (!m.forecasters) return null;
    const key = sigOf(m);
    let e = cache.get(key);
    if (!e) {
      e = { v: null };
      e.p = verifyMarket(m, { yieldTo: tick0 }).then((v) => { e.v = v; onDone(m, v); return v; });
      cache.set(key, e);
    }
    return e;
  };
}

// [state, headline, detail] for a market, given its verification (or null).
export function marketState(m, phase, v) {
  if (m.forecasters) {
    const bad = v?.colonies.some((c) => c.state === "mismatch") || v?.market?.state === "mismatch";
    if (bad) return ["bad", "✗ hash differs", `${m.cranked} of ${KINDS.length} cranked`];
    if (m.done) return v ? ["ok", "✓ verified here", "result final"] : ["", "◌ re-running here", "result final"];
    return ["", `◌ ${m.cranked} of ${KINDS.length} cranked`, v?.colonies.some((c) => c.state === "match") ? "✓ cranked ones match" : "colonies running"];
  }
  const t = m.stakes ? sumBig(m.stakes) : null;
  const staked = t === null ? "" : t ? `${fmtT(t)} $ANTO staked` : "no stakes yet";
  const ph = { posting: "◌ staking open", agents: "◌ agents posting", ready: "◌ ready to crank", running: "◌ ready to crank", skipped: "✗ skipped" }[phase] ?? esc(phase);
  return ["", ph, staked];
}

// Reuse a colony already replaying when its on-chain hash did not change.
export function colonyCache(extra = () => ({})) {
  const cache = new Map(); // spec key + seed + hash -> { col, startedAt, ... }
  return (f, seed) => {
    const key = `${f.key}|${seed}|${f.chainHash ?? "-"}`;
    let c = cache.get(key);
    if (!c) {
      const col = f.make();
      c = { col, startedAt: performance.now(), ...extra(col) };
      cache.set(key, c);
    }
    return c;
  };
}
